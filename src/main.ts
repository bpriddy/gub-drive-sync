/**
 * main.ts — Cloud Run Job entrypoint.
 *
 * One execution per `jobs:run`. The first positional argument selects the
 * mode (the six former HTTP endpoints of /integrations/google-drive/*):
 *
 *   poll                     → runIncrementalPoll (Cloud Scheduler target)
 *   run-full-sync            → startFullSync     (gub-admin Sync button,
 *                                                 operator gcloud)
 *   continue --sync-run-id X → continuePausedSync (self-trigger at chunk
 *                                                  budget; see runner.ts)
 *   cron                     → alias for run-full-sync
 *   notify                   → notifyReviewers   (on-demand email fan-out)
 *   sweep-expired            → sweepExpiredProposals (cron target)
 *   backfill-pending         → processBackfillQueue (drains the
 *                                                    drive_backfill_requests
 *                                                    queue; Cloud Scheduler
 *                                                    target)
 *   merge-campaign-dupes     → runCampaignMerge  (operator gcloud; one-shot
 *     --account-name X [--confirm]                 detect + merge duplicate
 *     [--min-confidence 0..1]                      campaigns. No --confirm =
 *                                                  dry-run.)
 *
 * Every work mode runs the reaper first — same self-heal as the original
 * router. Exit code: 0 success / 1 fatal. Cloud Run Jobs marks the
 * execution failed on non-zero, surfacing in the job history without any
 * extra monitoring surface.
 */

import { config } from './config';
import { prisma } from './prisma';
import { reapStaleSyncs } from './drive/reaper';
import { runIncrementalPoll } from './drive/poll';
import { sweepExpiredProposals } from './drive/sweep';
import { notifyReviewers } from './drive/notify';
import {
  NoSuchPausedSyncError,
  SyncAlreadyRunningError,
  continuePausedSync,
  startFullSync,
} from './drive/runner';
import { processBackfillQueue } from './drive/backfill-queue';
import { runCampaignMerge } from './drive/campaign-merge';

type Mode =
  | 'poll'
  | 'run-full-sync'
  | 'continue'
  | 'cron'
  | 'notify'
  | 'sweep-expired'
  | 'backfill-pending'
  | 'merge-campaign-dupes';

const ALL_MODES: readonly Mode[] = [
  'poll',
  'run-full-sync',
  'continue',
  'cron',
  'notify',
  'sweep-expired',
  'backfill-pending',
  'merge-campaign-dupes',
];

interface ParsedArgs {
  mode: Mode;
  syncRunId?: string;
  accountId?: string;
  accountName?: string;
  /** merge-campaign-dupes: actually apply (delete rows). Absent = dry-run. */
  confirm?: boolean;
  /** merge-campaign-dupes: raise the merge confidence floor above 0.8. */
  minConfidence?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv[0]=node, argv[1]=dist/src/main.js, argv[2]=mode, ...
  const positional = argv.slice(2);
  const mode = positional[0];
  if (!mode || !ALL_MODES.includes(mode as Mode)) {
    throw new Error(
      `usage: main.js <mode> [flags]\n  mode: ${ALL_MODES.join(' | ')}\n  got: ${mode ?? '<none>'}`,
    );
  }

  const out: ParsedArgs = { mode: mode as Mode };

  if (mode === 'continue') {
    // Accept --sync-run-id=X or --sync-run-id X
    for (let i = 1; i < positional.length; i++) {
      const arg = positional[i]!;
      if (arg.startsWith('--sync-run-id=')) {
        out.syncRunId = arg.slice('--sync-run-id='.length);
      } else if (arg === '--sync-run-id') {
        out.syncRunId = positional[i + 1];
        i++;
      }
    }
    if (!out.syncRunId) {
      throw new Error(`mode=continue requires --sync-run-id <uuid>`);
    }
  }

  if (mode === 'merge-campaign-dupes') {
    // --account-id <uuid> | --account-name <fragment> (one required)
    // --confirm                (apply; absent = dry-run)
    // --min-confidence <0..1>  (optional; raises the 0.8 floor)
    const takeValue = (arg: string, flag: string, i: number): string | undefined => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      if (arg === flag) return positional[i + 1];
      return undefined;
    };
    for (let i = 1; i < positional.length; i++) {
      const arg = positional[i]!;
      const acctId = takeValue(arg, '--account-id', i);
      if (acctId !== undefined) {
        out.accountId = acctId;
        if (arg === '--account-id') i++;
        continue;
      }
      const acctName = takeValue(arg, '--account-name', i);
      if (acctName !== undefined) {
        out.accountName = acctName;
        if (arg === '--account-name') i++;
        continue;
      }
      const minConf = takeValue(arg, '--min-confidence', i);
      if (minConf !== undefined) {
        const parsed = Number(minConf);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new Error(`--min-confidence must be a number in [0,1], got: ${minConf}`);
        }
        out.minConfidence = parsed;
        if (arg === '--min-confidence') i++;
        continue;
      }
      if (arg === '--confirm') out.confirm = true;
    }
    if (!out.accountId && !out.accountName) {
      throw new Error('mode=merge-campaign-dupes requires --account-id <uuid> or --account-name <fragment>');
    }
  }

  return out;
}

async function runMode(args: ParsedArgs): Promise<Record<string, unknown>> {
  switch (args.mode) {
    case 'poll': {
      await reapStaleSyncs();
      const result = await runIncrementalPoll();
      // If a full sync was dispatched, await its in-process promise so
      // this Job execution stays alive for the duration of the chunk.
      // The runner's chunked architecture means a multi-chunk run will
      // self-trigger a fresh execution at the chunk boundary and this
      // promise will resolve once the chunk's `paused` state is persisted.
      if (result.dispatchedSyncPromise) {
        await result.dispatchedSyncPromise;
      }
      // Strip the promise from the returned outcome (not JSON-serializable).
      const { dispatchedSyncPromise: _drop, ...summary } = result;
      void _drop;
      return summary as unknown as Record<string, unknown>;
    }

    case 'run-full-sync':
    case 'cron': {
      await reapStaleSyncs();
      try {
        const { promise } = await startFullSync();
        // Await the in-process promise so this Job execution stays alive
        // for the duration of the chunk (or the whole sync if it fits in
        // one). When the runner self-triggers a continuation, this
        // execution will exit shortly after that scheduleContinuation
        // call resolves — the new execution carries on.
        const final = await promise;
        // `final` already carries syncRunId (from RunFullSyncResult).
        return { status: 'sync_started', ...final };
      } catch (err) {
        if (err instanceof SyncAlreadyRunningError) {
          return {
            status: 'already_running',
            code: 'SYNC_ALREADY_RUNNING',
            syncRunId: err.existingRunId,
            existingStatus: err.status,
          };
        }
        throw err;
      }
    }

    case 'continue': {
      await reapStaleSyncs();
      const id = args.syncRunId!;
      try {
        const { promise } = await continuePausedSync(id);
        const final = await promise;
        return { status: 'sync_resumed', ...final };
      } catch (err) {
        if (err instanceof NoSuchPausedSyncError) {
          // The paused sync was reaped (or never existed). Don't throw —
          // exiting non-zero would mark the Job execution failed, which
          // is misleading. Return a structured outcome and exit cleanly.
          return { status: 'no_such_paused_sync', message: err.message };
        }
        throw err;
      }
    }

    case 'notify': {
      const result = await notifyReviewers();
      return result as unknown as Record<string, unknown>;
    }

    case 'sweep-expired': {
      const result = await sweepExpiredProposals();
      return result as unknown as Record<string, unknown>;
    }

    case 'backfill-pending': {
      // No reapStaleSyncs() here — that's for the legacy poll/runner
      // sync-runs. The backfill queue does its own stale-recovery on
      // entry (rows stuck in 'running' for >60min).
      const result = await processBackfillQueue();
      return result as unknown as Record<string, unknown>;
    }

    case 'merge-campaign-dupes': {
      // Orthogonal to sync state — no reapStaleSyncs(). One-shot detect +
      // (with --confirm) merge of duplicate campaigns for one account.
      const result = await runCampaignMerge({
        ...(args.accountId ? { accountId: args.accountId } : {}),
        ...(args.accountName ? { accountName: args.accountName } : {}),
        apply: args.confirm ?? false,
        ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
      });
      return result as unknown as Record<string, unknown>;
    }
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = parseArgs(process.argv);

  console.log(
    JSON.stringify({
      msg: 'gub-drive-sync starting',
      mode: args.mode,
      env: config.NODE_ENV,
      ...(args.syncRunId ? { syncRunId: args.syncRunId } : {}),
    }),
  );

  const outcome = await runMode(args);

  console.log(
    JSON.stringify({
      msg: 'gub-drive-sync complete',
      mode: args.mode,
      outcome,
      durationMs: Date.now() - startedAt,
    }),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(
      JSON.stringify({
        msg: 'gub-drive-sync fatal',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
