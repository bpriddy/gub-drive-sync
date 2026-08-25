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
 *                                                    queue — bootstrap rows
 *                                                    day-walk + auto-apply;
 *                                                    forward rows drain the
 *                                                    Activity window and
 *                                                    PROPOSE for review)
 *   seed-edit-stats          → seedEditStats (one-shot ~1y historical
 *     [--account-id X]         drive_edit_stats seed; stats only)
 *   merge-campaign-dupes     → runCampaignMerge  (operator gcloud; one-shot
 *     --account-name X [--confirm]                 detect + merge duplicate
 *     [--min-confidence 0..1]                      campaigns. No --confirm =
 *                                                  dry-run.)
 *   clear-account            → clearAccountComplete (operator gcloud; COMPLETE
 *     --account-name X [--confirm]                   per-account nuke for a
 *                                                    clean re-bootstrap. No
 *                                                    --confirm = dry-run counts.)
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
import { DRIVE_SYNC_SYSTEM_STAFF_ID } from './drive/heal';
import { seedEditStats } from './forward/seed';
import { runCampaignMerge } from './drive/campaign-merge';
import { clearAccountComplete } from './drive/clear-account';
import { resolveIdeaTarget, runIdeaExtraction } from './drive/idea-runner';
import { derivePiecesForAccount } from './drive/piece-derive';

type Mode =
  | 'poll'
  | 'forward-all'
  | 'run-full-sync'
  | 'continue'
  | 'cron'
  | 'notify'
  | 'sweep-expired'
  | 'backfill-pending'
  | 'merge-campaign-dupes'
  | 'clear-account'
  | 'extract-ideas'
  | 'derive-pieces'
  | 'seed-edit-stats';

const ALL_MODES: readonly Mode[] = [
  'poll',
  'forward-all',
  'run-full-sync',
  'continue',
  'cron',
  'notify',
  'sweep-expired',
  'backfill-pending',
  'merge-campaign-dupes',
  'clear-account',
  'extract-ideas',
  'derive-pieces',
  'seed-edit-stats',
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
  /** merge-campaign-dupes clustering tuning. */
  windowSize?: number;
  voteThreshold?: number;
  /** extract-ideas targeting. */
  campaignName?: string;
  folderId?: string;
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
      const win = takeValue(arg, '--window', i);
      if (win !== undefined) {
        const parsed = Number(win);
        if (!Number.isInteger(parsed) || parsed < 2) {
          throw new Error(`--window must be an integer >= 2, got: ${win}`);
        }
        out.windowSize = parsed;
        if (arg === '--window') i++;
        continue;
      }
      const votes = takeValue(arg, '--vote-threshold', i);
      if (votes !== undefined) {
        const parsed = Number(votes);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`--vote-threshold must be an integer >= 1, got: ${votes}`);
        }
        out.voteThreshold = parsed;
        if (arg === '--vote-threshold') i++;
        continue;
      }
      if (arg === '--confirm') out.confirm = true;
    }
    if (!out.accountId && !out.accountName) {
      throw new Error('mode=merge-campaign-dupes requires --account-id <uuid> or --account-name <fragment>');
    }
  }

  if (mode === 'clear-account') {
    // --account-id <uuid> | --account-name <fragment> (one required)
    // --confirm  (apply; absent = dry-run counts only)
    for (let i = 1; i < positional.length; i++) {
      const arg = positional[i]!;
      if (arg.startsWith('--account-id=')) out.accountId = arg.slice('--account-id='.length);
      else if (arg === '--account-id') { out.accountId = positional[i + 1]; i++; }
      else if (arg.startsWith('--account-name=')) out.accountName = arg.slice('--account-name='.length);
      else if (arg === '--account-name') { out.accountName = positional[i + 1]; i++; }
      else if (arg === '--confirm') out.confirm = true;
    }
    if (!out.accountId && !out.accountName) {
      throw new Error('mode=clear-account requires --account-id <uuid> or --account-name <fragment>');
    }
  }

  if (mode === 'extract-ideas') {
    // --account-name X (or --account-id) + one of --campaign-name X | --folder-id X
    // --confirm  (persist; absent = dry-run report)
    for (let i = 1; i < positional.length; i++) {
      const arg = positional[i]!;
      if (arg.startsWith('--account-id=')) out.accountId = arg.slice('--account-id='.length);
      else if (arg === '--account-id') { out.accountId = positional[i + 1]; i++; }
      else if (arg.startsWith('--account-name=')) out.accountName = arg.slice('--account-name='.length);
      else if (arg === '--account-name') { out.accountName = positional[i + 1]; i++; }
      else if (arg.startsWith('--campaign-name=')) out.campaignName = arg.slice('--campaign-name='.length);
      else if (arg === '--campaign-name') { out.campaignName = positional[i + 1]; i++; }
      else if (arg.startsWith('--folder-id=')) out.folderId = arg.slice('--folder-id='.length);
      else if (arg === '--folder-id') { out.folderId = positional[i + 1]; i++; }
      else if (arg === '--confirm') out.confirm = true;
    }
    if (!out.accountId && !out.accountName) {
      throw new Error('mode=extract-ideas requires --account-name <fragment> (or --account-id)');
    }
    if (!out.campaignName && !out.folderId) {
      throw new Error('mode=extract-ideas requires --campaign-name <name> or --folder-id <drive folder id>');
    }
  }

  if (mode === 'derive-pieces') {
    // --account-name X (or --account-id)
    // --confirm  (create pieces; absent = dry-run report)
    for (let i = 1; i < positional.length; i++) {
      const arg = positional[i]!;
      if (arg.startsWith('--account-id=')) out.accountId = arg.slice('--account-id='.length);
      else if (arg === '--account-id') { out.accountId = positional[i + 1]; i++; }
      else if (arg.startsWith('--account-name=')) out.accountName = arg.slice('--account-name='.length);
      else if (arg === '--account-name') { out.accountName = positional[i + 1]; i++; }
      else if (arg === '--confirm') out.confirm = true;
    }
    if (!out.accountId && !out.accountName) {
      throw new Error('mode=derive-pieces requires --account-name <fragment> (or --account-id)');
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

    case 'seed-edit-stats': {
      const result = await seedEditStats({
        ...(args.accountId ? { accountId: args.accountId } : {}),
      });
      return result as unknown as Record<string, unknown>;
    }

    case 'backfill-pending': {
      // No reapStaleSyncs() here — that's for the legacy poll/runner
      // sync-runs. The backfill queue does its own stale-recovery on
      // entry (rows stuck in 'running' for >60min).
      const result = await processBackfillQueue();
      return result as unknown as Record<string, unknown>;
    }

    case 'forward-all': {
      // Scheduled forward-sync-v2 driver. Replaces the legacy `mode=poll`
      // path for the daily scheduler tick (see terraform/drive_poll.tf).
      //
      // Two steps in one execution:
      //   1. Enqueue a `mode=forward` driveSyncRun for every account that
      //      has finished bootstrap. Skip accounts that already have a
      //      pending or running forward row — otherwise a slow prior
      //      forward run would collect a duplicate every scheduler tick.
      //   2. Drain via processBackfillQueue(), which is the same code
      //      path a Backfill-button click uses. Reuses heartbeat, stale-
      //      reclaim, per-row retry, error surfaces — no new engine
      //      logic.
      //
      // requestedBy = DRIVE_SYNC_SYSTEM_STAFF_ID (the seeded system staff
      // row) so the audit trail reads "scheduled system enqueue", not an
      // operator's identity — same pattern the auto-continuation chain
      // in backfill-queue already uses.
      const eligible = await prisma.account.findMany({
        where: {
          driveBootstrapCompletedAt: { not: null },
        },
        select: { id: true, name: true },
      });

      let enqueued = 0;
      let skippedInFlight = 0;
      for (const acc of eligible) {
        const inFlight = await prisma.driveSyncRun.findFirst({
          where: {
            accountId: acc.id,
            mode: 'forward',
            status: { in: ['pending', 'running'] },
          },
          select: { id: true },
        });
        if (inFlight) {
          skippedInFlight += 1;
          continue;
        }
        await prisma.driveSyncRun.create({
          data: {
            accountId: acc.id,
            mode: 'forward',
            requestedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
            allRemaining: false,
            logSummary: 'scheduled forward-all enqueue',
          },
        });
        enqueued += 1;
      }

      const drain = await processBackfillQueue();
      return {
        eligibleAccounts: eligible.length,
        enqueued,
        skippedInFlight,
        drain,
      } as unknown as Record<string, unknown>;
    }

    case 'merge-campaign-dupes': {
      // Orthogonal to sync state — no reapStaleSyncs(). One-shot detect +
      // (with --confirm) merge of duplicate campaigns for one account.
      const result = await runCampaignMerge({
        ...(args.accountId ? { accountId: args.accountId } : {}),
        ...(args.accountName ? { accountName: args.accountName } : {}),
        apply: args.confirm ?? false,
        ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
        ...(args.windowSize !== undefined ? { windowSize: args.windowSize } : {}),
        ...(args.voteThreshold !== undefined ? { voteThreshold: args.voteThreshold } : {}),
      });
      return result as unknown as Record<string, unknown>;
    }

    case 'clear-account': {
      // Orthogonal to sync state — no reapStaleSyncs(). Complete per-account
      // nuke for a clean re-bootstrap. No --confirm = dry-run (counts only).
      const result = await clearAccountComplete({
        ...(args.accountId ? { accountId: args.accountId } : {}),
        ...(args.accountName ? { accountName: args.accountName } : {}),
        apply: args.confirm ?? false,
      });
      return result as unknown as Record<string, unknown>;
    }

    case 'derive-pieces': {
      // Pieces the PRIMARY way: identified executions from each campaign's
      // dossier (content-born), reconciled against folder-born pieces.
      // No --confirm = dry-run report; --confirm creates folder-less rows.
      const account = args.accountId
        ? await prisma.account.findUnique({ where: { id: args.accountId }, select: { id: true, name: true } })
        : await prisma.account.findFirst({
            where: { name: { contains: args.accountName!, mode: 'insensitive' } },
            select: { id: true, name: true },
          });
      if (!account) throw new Error('account not found');
      const results = await derivePiecesForAccount({ accountId: account.id, apply: args.confirm ?? false });
      return { accountName: account.name, apply: args.confirm ?? false, campaigns: results } as unknown as Record<string, unknown>;
    }

    case 'extract-ideas': {
      // Focused idea extraction over a campaign/folder. No --confirm = dry-run
      // (report the ideas found); --confirm persists them.
      const target = await resolveIdeaTarget({
        ...(args.accountId ? { accountId: args.accountId } : {}),
        ...(args.accountName ? { accountName: args.accountName } : {}),
        ...(args.campaignName ? { campaignName: args.campaignName } : {}),
        ...(args.folderId ? { folderId: args.folderId } : {}),
      });
      const result = await runIdeaExtraction({ ...target, apply: args.confirm ?? false });
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
