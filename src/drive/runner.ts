/**
 * drive.runner.ts — Full Drive sync orchestrator.
 *
 * What a "full sync" does, in order:
 *   1. Phase 1 — discoverNewEntities(): scan the shared-drive root for folders
 *      that don't yet map to an account/campaign row; emit new_entity proposals.
 *   2. Phase 2 — for every account with drive_folder_id set: scanEntity().
 *      Delta snapshots skip unchanged files automatically.
 *   3. Phase 3 — for every campaign with drive_folder_id set: scanEntity().
 *   4. Phase 4 — notifyReviewers(): group new proposals by owner, email each
 *      a magic link.
 *   5. captureStartPageTokenAfterFullSync(): persist a fresh start page token
 *      so the next /poll has somewhere to call from. Bootstrap completes here.
 *
 * Pacing: env-tunable delays between entities so a cold first run doesn't
 * burn a day's Gemini quota in 10 minutes.
 *
 * Concurrency guard: refuses to start a new full sync if one is already
 * running (status='running') or paused waiting for continuation
 * (status='paused'). `sync_runs` table is the source of truth.
 *
 * ── Chunking (bootstrap path) ───────────────────────────────────────────────
 * One Cloud Run Job execution can run for up to 24h (task-timeout), but
 * we cap each execution's productive work at 50 minutes to keep
 * checkpoints frequent and bounded. If the budget trips:
 *   1. Persist where we stopped (sync_run.status='paused', chunk_phase, chunk_index).
 *   2. Self-trigger a fresh Job execution via the Cloud Run Admin API
 *      (`jobs:run` on its OWN job name with args=["continue",
 *      "--sync-run-id", X]). The runtime SA holds `roles/run.developer`
 *      on this Job — set by setup-gcp.sh after first deploy.
 *   3. Return cleanly from this execution; the fresh execution picks up
 *      from the checkpoint.
 * For typical small folders the wall-clock check never trips and chunking is
 * invisible. See README "Chunking" for the math.
 */

import { GoogleAuth } from 'google-auth-library';
import { config } from '../config';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { discoverNewEntities } from './discover';
import { notifyReviewers } from './notify';
import { captureStartPageTokenAfterFullSync } from './poll';
import { scanEntity, type ScanEntityResult } from './orchestrator';

// 50 min wall-clock budget per chunk. Each chunk checkpoint persists state
// and self-triggers a fresh execution; bounded chunks keep the failure-
// recovery window short (the reaper's PAUSED_THRESHOLD_MINUTES=60min kicks in
// if a checkpointed continuation never lands).
const CHUNK_BUDGET_MS = 50 * 60 * 1000;

// Phase numbers map to the lifecycle steps above. Discovery and notify are
// both fast (one-shot per phase); only accounts (2) and campaigns (3) iterate
// large entity lists, so chunking checkpoints land on those.
const PHASE_DISCOVERY = 1;
const PHASE_ACCOUNTS = 2;
const PHASE_CAMPAIGNS = 3;
const PHASE_NOTIFY = 4;

export interface RunFullSyncResult {
  syncRunId: string;
  discover: {
    accountsProposed: number;
    campaignsProposed: number;
    foldersSkipped: number;
  };
  accountsScanned: number;
  campaignsScanned: number;
  proposalsCreated: number;
  notesWritten: number;
  ambiguousWritten: number;
  notify: {
    ownersEmailed: number;
    proposalsNotified: number;
    orphansLogged: number;
  };
  errors: number;
  durationMs: number;
  /** True if the run paused mid-flight and a continuation was scheduled. */
  paused: boolean;
}

export class SyncAlreadyRunningError extends Error {
  constructor(public readonly existingRunId: string, public readonly status: 'running' | 'paused') {
    super(`A Drive sync is already ${status} (id=${existingRunId})`);
    this.name = 'SyncAlreadyRunningError';
  }
}

export class NoSuchPausedSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoSuchPausedSyncError';
  }
}

interface ResumeCheckpoint {
  phase: number;
  index: number;
}

/** Aggregates carried across chunk boundaries. */
type Totals = {
  accountsProposed: number;
  campaignsProposed: number;
  foldersSkipped: number;
  accountsScanned: number;
  campaignsScanned: number;
  proposalsCreated: number;
  notesWritten: number;
  ambiguousWritten: number;
  ownersEmailed: number;
  proposalsNotified: number;
  orphansLogged: number;
  errors: number;
};

function newTotals(): Totals {
  return {
    accountsProposed: 0,
    campaignsProposed: 0,
    foldersSkipped: 0,
    accountsScanned: 0,
    campaignsScanned: 0,
    proposalsCreated: 0,
    notesWritten: 0,
    ambiguousWritten: 0,
    ownersEmailed: 0,
    proposalsNotified: 0,
    orphansLogged: 0,
    errors: 0,
  };
}

/**
 * Start a full sync. Creates the sync_runs row synchronously (so the caller
 * can return the id immediately) then returns a promise that resolves when
 * the full run finishes (or reaches a chunk-pause checkpoint). Endpoint
 * handlers typically await only the id creation and let the promise run in
 * the background.
 */
export async function startFullSync(): Promise<{
  syncRunId: string;
  promise: Promise<RunFullSyncResult>;
}> {
  // Refuse if one is already in flight or paused waiting for continuation.
  const inFlight = await prisma.syncRun.findFirst({
    where: {
      source: 'google_drive',
      status: { in: ['running', 'paused'] },
    },
    orderBy: { startedAt: 'desc' },
  });
  if (inFlight) {
    throw new SyncAlreadyRunningError(
      inFlight.id,
      inFlight.status as 'running' | 'paused',
    );
  }

  const run = await prisma.syncRun.create({
    data: { source: 'google_drive', status: 'running' },
  });
  logger.info({ syncRunId: run.id }, '[drive.runner] full sync started');

  const promise = executeFullSync(run.id, undefined);
  return { syncRunId: run.id, promise };
}

/**
 * Resume a previously-paused sync (called by /run-full-sync/continue).
 * The paused sync_run already has chunk_phase + chunk_index set; we read
 * them and resume from there.
 */
export async function continuePausedSync(syncRunId: string): Promise<{
  syncRunId: string;
  promise: Promise<RunFullSyncResult>;
}> {
  const run = await prisma.syncRun.findUnique({ where: { id: syncRunId } });
  if (!run) {
    throw new NoSuchPausedSyncError(`No sync_run with id ${syncRunId}`);
  }
  if (run.source !== 'google_drive') {
    throw new NoSuchPausedSyncError(`sync_run ${syncRunId} is not a google_drive run`);
  }
  if (run.status !== 'paused') {
    throw new NoSuchPausedSyncError(
      `sync_run ${syncRunId} is status=${run.status}, expected 'paused'`,
    );
  }
  if (run.chunkPhase == null || run.chunkIndex == null) {
    throw new NoSuchPausedSyncError(
      `sync_run ${syncRunId} is paused but has no checkpoint (chunk_phase/index null)`,
    );
  }

  // Flip back to running before we resume; if the resume itself crashes
  // hard, the catch handler will mark it failed.
  await prisma.syncRun.update({
    where: { id: syncRunId },
    data: { status: 'running' },
  });
  logger.info(
    { syncRunId, chunkPhase: run.chunkPhase, chunkIndex: run.chunkIndex },
    '[drive.runner] resuming paused sync',
  );

  const resume: ResumeCheckpoint = {
    phase: run.chunkPhase,
    index: run.chunkIndex,
  };
  const promise = executeFullSync(syncRunId, resume);
  return { syncRunId, promise };
}

async function executeFullSync(
  syncRunId: string,
  resume: ResumeCheckpoint | undefined,
): Promise<RunFullSyncResult> {
  const startedAt = Date.now();
  const totals = newTotals();
  const startPhase = resume?.phase ?? PHASE_DISCOVERY;
  const startIndex = resume?.index ?? 0;

  // Track whether we've checkpoint-paused so the catch + finalize logic knows
  // not to overwrite the 'paused' status with 'success'.
  let paused = false;
  let pauseAt: ResumeCheckpoint | null = null;

  const overBudget = (): boolean => Date.now() - startedAt > CHUNK_BUDGET_MS;

  try {
    // ── Phase 1: Discovery ────────────────────────────────────────────────
    // Discovery is one shot per run — never resumed mid-phase, only skipped
    // entirely if we're resuming from a later phase.
    if (startPhase <= PHASE_DISCOVERY) {
      const discover = await discoverNewEntities({ syncRunId });
      totals.accountsProposed = discover.accountsProposed;
      totals.campaignsProposed = discover.campaignsProposed;
      totals.foldersSkipped = discover.foldersSkipped;
    }

    // ── Phase 2: Linked accounts ──────────────────────────────────────────
    if (startPhase <= PHASE_ACCOUNTS && !pauseAt) {
      const accounts = await prisma.account.findMany({
        where: { driveFolderId: { not: null } },
        select: { id: true, name: true },
        orderBy: { id: 'asc' }, // stable ordering across resumes
      });
      const fromIndex = startPhase === PHASE_ACCOUNTS ? startIndex : 0;
      for (let i = fromIndex; i < accounts.length; i++) {
        if (overBudget()) {
          pauseAt = { phase: PHASE_ACCOUNTS, index: i };
          break;
        }
        const account = accounts[i]!;
        try {
          const res = await scanEntity({
            entityType: 'account',
            entityId: account.id,
            syncRunId,
          });
          tallyScanResult(totals, res);
          totals.accountsScanned++;
        } catch (err) {
          totals.errors++;
          logger.error({ err, accountId: account.id }, '[drive.runner] scanEntity(account) failed');
        }
        await pace(config.DRIVE_DELAY_BETWEEN_ACCOUNTS_MS);
      }
    }

    // ── Phase 3: Linked campaigns ─────────────────────────────────────────
    if (startPhase <= PHASE_CAMPAIGNS && !pauseAt) {
      const campaigns = await prisma.campaign.findMany({
        where: { driveFolderId: { not: null } },
        select: { id: true, name: true, accountId: true },
        orderBy: { id: 'asc' },
      });
      const fromIndex = startPhase === PHASE_CAMPAIGNS ? startIndex : 0;
      for (let i = fromIndex; i < campaigns.length; i++) {
        if (overBudget()) {
          pauseAt = { phase: PHASE_CAMPAIGNS, index: i };
          break;
        }
        const campaign = campaigns[i]!;
        try {
          const res = await scanEntity({
            entityType: 'campaign',
            entityId: campaign.id,
            syncRunId,
            parentAccountId: campaign.accountId,
          });
          tallyScanResult(totals, res);
          totals.campaignsScanned++;
        } catch (err) {
          totals.errors++;
          logger.error({ err, campaignId: campaign.id }, '[drive.runner] scanEntity(campaign) failed');
        }
        await pace(config.DRIVE_DELAY_BETWEEN_CAMPAIGNS_MS);
      }
    }

    // ── Pause checkpoint? ────────────────────────────────────────────────
    if (pauseAt) {
      paused = true;
      const durationMs = Date.now() - startedAt;
      await prisma.syncRun.update({
        where: { id: syncRunId },
        data: {
          status: 'paused',
          chunkPhase: pauseAt.phase,
          chunkIndex: pauseAt.index,
          durationMs,
          totalScanned: totals.accountsScanned + totals.campaignsScanned,
          updated: totals.proposalsCreated,
          errored: totals.errors,
        },
      });
      logger.info(
        { syncRunId, ...pauseAt, elapsed: durationMs },
        '[drive.runner] chunk budget exceeded — paused for continuation',
      );
      await scheduleContinuation(syncRunId);
      return finalizeResult(syncRunId, totals, durationMs, /* paused */ true);
    }

    // ── Phase 4: Notify reviewers ────────────────────────────────────────
    // Notify is one-shot; if we got here we're past all chunked phases.
    if (startPhase <= PHASE_NOTIFY) {
      try {
        const notify = await notifyReviewers({ syncRunId });
        totals.ownersEmailed = notify.ownersEmailed;
        totals.proposalsNotified = notify.proposalsNotified;
        totals.orphansLogged = notify.orphansLogged;
      } catch (err) {
        totals.errors++;
        logger.error({ err, syncRunId }, '[drive.runner] notifyReviewers failed');
      }
    }

    // ── Finalize: terminal state + page-token capture ────────────────────
    const durationMs = Date.now() - startedAt;
    const summary = buildSummary(totals, durationMs);

    await prisma.syncRun.update({
      where: { id: syncRunId },
      data: {
        status: 'success',
        completedAt: new Date(),
        durationMs,
        totalScanned: totals.accountsScanned + totals.campaignsScanned,
        updated: totals.proposalsCreated,
        errored: totals.errors,
        chunkPhase: null,
        chunkIndex: null,
        summary: JSON.stringify(summary, null, 2),
      },
    });

    // Capture a fresh start page token now that the bootstrap is complete.
    // Failures here log but don't fail the sync — see drive.poll.ts comment.
    await captureStartPageTokenAfterFullSync(syncRunId);

    logger.info({ syncRunId, ...summary }, '[drive.runner] full sync complete');
    return finalizeResult(syncRunId, totals, durationMs, /* paused */ false);
  } catch (err) {
    if (paused) {
      // Pause path completed successfully; this catch shouldn't fire after
      // pause but log defensively if it does.
      logger.error(
        { err, syncRunId },
        '[drive.runner] error after pause checkpoint — sync state may be inconsistent',
      );
      throw err;
    }
    const durationMs = Date.now() - startedAt;
    logger.error({ err, syncRunId }, '[drive.runner] full sync failed hard');
    await prisma.syncRun.update({
      where: { id: syncRunId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        durationMs,
        chunkPhase: null,
        chunkIndex: null,
        summary: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

function finalizeResult(
  syncRunId: string,
  totals: Totals,
  durationMs: number,
  paused: boolean,
): RunFullSyncResult {
  return {
    syncRunId,
    discover: {
      accountsProposed: totals.accountsProposed,
      campaignsProposed: totals.campaignsProposed,
      foldersSkipped: totals.foldersSkipped,
    },
    accountsScanned: totals.accountsScanned,
    campaignsScanned: totals.campaignsScanned,
    proposalsCreated: totals.proposalsCreated,
    notesWritten: totals.notesWritten,
    ambiguousWritten: totals.ambiguousWritten,
    notify: {
      ownersEmailed: totals.ownersEmailed,
      proposalsNotified: totals.proposalsNotified,
      orphansLogged: totals.orphansLogged,
    },
    errors: totals.errors,
    durationMs,
    paused,
  };
}

function buildSummary(totals: Totals, durationMs: number): Record<string, unknown> {
  return {
    discover: {
      accountsProposed: totals.accountsProposed,
      campaignsProposed: totals.campaignsProposed,
      foldersSkipped: totals.foldersSkipped,
    },
    accountsScanned: totals.accountsScanned,
    campaignsScanned: totals.campaignsScanned,
    proposalsCreated: totals.proposalsCreated,
    notesWritten: totals.notesWritten,
    ambiguousWritten: totals.ambiguousWritten,
    notify: {
      ownersEmailed: totals.ownersEmailed,
      proposalsNotified: totals.proposalsNotified,
      orphansLogged: totals.orphansLogged,
    },
    errors: totals.errors,
    durationMs,
  };
}

/**
 * Self-trigger a fresh Cloud Run Job execution to resume the paused sync.
 *
 * Replaces the old HTTP self-POST. We call the Cloud Run Admin API
 * (`jobs:run`) on THIS job, with a per-execution argument override that
 * makes the fresh execution dispatch to mode='continue' with the paused
 * syncRunId. ADC via GoogleAuth — the runtime SA carries
 * `roles/run.developer` scoped to this job (set by setup-gcp.sh after
 * first deploy).
 *
 * Fire-and-forget: we await the API call here (we want to know the
 * continuation was actually queued before this Job execution exits) but
 * we don't wait for the new execution to finish. If the API call fails
 * the sync_run stays paused; the next entry's reaper sees it 60min later
 * and force-fails it, surfacing the misconfiguration.
 */
async function scheduleContinuation(syncRunId: string): Promise<void> {
  const project = config.GCP_PROJECT_ID;
  const region = config.GCP_REGION;
  const job = config.DRIVE_SYNC_JOB_NAME;
  if (!project || !region || !job) {
    logger.error(
      { syncRunId, project: !!project, region: !!region, job: !!job },
      '[drive.runner] cannot schedule continuation — GCP_PROJECT_ID / GCP_REGION / DRIVE_SYNC_JOB_NAME must all be set',
    );
    return;
  }

  const url =
    `https://run.googleapis.com/v2/projects/${project}` +
    `/locations/${region}/jobs/${job}:run`;

  // Per-execution argument override. Cloud Run Jobs supports overriding
  // `containerOverrides[].args` at runtime to vary behavior without
  // redeploying the image. The fresh execution boots, main.ts sees
  // ['continue', '--sync-run-id', X], dispatches to continuePausedSync.
  const body = {
    overrides: {
      containerOverrides: [
        {
          args: ['continue', '--sync-run-id', syncRunId],
        },
      ],
    },
  };

  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    await client.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: body,
    });
    logger.info(
      { syncRunId, job },
      '[drive.runner] continuation self-trigger dispatched (Admin API)',
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), syncRunId, job },
      '[drive.runner] continuation self-trigger failed — sync_run will be reaped after PAUSED_THRESHOLD_MINUTES',
    );
  }
}

function tallyScanResult(totals: Totals, res: ScanEntityResult): void {
  totals.proposalsCreated += res.proposalsCreated;
  totals.notesWritten += res.notesWritten;
  totals.ambiguousWritten += res.ambiguousWritten;
  totals.errors += res.scan.errors;
}

function pace(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
