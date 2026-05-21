/**
 * drive.reaper.ts — Stale-sync reaper for Drive sync_runs.
 *
 * Background. Drive syncs run as fire-and-forget background work after a
 * 202 response. If the Cloud Run instance dies between checkpoint persist
 * and self-call dispatch (or if the self-call fails for any reason), the
 * sync_run is left stuck in 'running' or 'paused' indefinitely. Without
 * intervention, this blocks all subsequent syncs (the concurrency guard
 * in startFullSync refuses to start a new run while one is running/paused).
 *
 * The reaper detects these stuck rows by their lack of recent activity —
 * specifically, sync_runs.updated_at, which is bumped on every row update
 * via a DB trigger (and Prisma's @updatedAt). When a row's updated_at is
 * older than the configured threshold, we force-flip status='failed' and
 * clear the chunking checkpoint, freeing the slot for a new sync.
 *
 * Thresholds were calibrated against this org's actual operational scale
 * (max ~100 files per project, max ~1,000 files in a pathological multi-
 * project batch onboarding day). At 50-min chunks per ~150 files, the
 * worst realistic full sync is ~6 hours; the 24h `running` threshold has
 * 4x margin against that.
 *
 *   paused  > 60 min  → reap. Self-call delivery is sub-second; an hour
 *                       past pause is unambiguously a delivery failure.
 *   running > 24 hr   → reap. Longer than any realistic legitimate sync
 *                       at this scale.
 *
 * The reaper runs at the entry of /poll, /run-full-sync, and
 * /run-full-sync/continue — every Drive request becomes a self-healing
 * trigger. The query is cheap (indexed on status), and reaper work is
 * idempotent (no-op when nothing matches).
 */

import { prisma } from '../prisma';
import { logger } from '../logger';

/** Threshold for 'running' rows. Calibrated against this org's actual scale. */
export const RUNNING_THRESHOLD_MINUTES = 24 * 60; // 24 hours

/** Threshold for 'paused' rows. Self-call delivery is sub-second, so 1h is "definitely lost". */
export const PAUSED_THRESHOLD_MINUTES = 60; // 1 hour

export interface ReaperResult {
  runningReaped: number;
  pausedReaped: number;
}

/**
 * Reap any Drive sync_runs that have been stuck without progress past
 * their threshold. Idempotent — no-op when nothing qualifies.
 *
 * Errors are logged but never thrown: a transient DB blip during the
 * reaper check should not fail the request that triggered it. The next
 * request will retry naturally.
 */
export async function reapStaleSyncs(): Promise<ReaperResult> {
  const now = Date.now();
  const runningCutoff = new Date(now - RUNNING_THRESHOLD_MINUTES * 60_000);
  const pausedCutoff = new Date(now - PAUSED_THRESHOLD_MINUTES * 60_000);

  try {
    const runningResult = await prisma.syncRun.updateMany({
      where: {
        source: 'google_drive',
        status: 'running',
        updatedAt: { lt: runningCutoff },
      },
      data: {
        status: 'failed',
        completedAt: new Date(),
        chunkPhase: null,
        chunkIndex: null,
        summary: `reaped: stuck in 'running' >${RUNNING_THRESHOLD_MINUTES} min without progress`,
      },
    });

    const pausedResult = await prisma.syncRun.updateMany({
      where: {
        source: 'google_drive',
        status: 'paused',
        updatedAt: { lt: pausedCutoff },
      },
      data: {
        status: 'failed',
        completedAt: new Date(),
        chunkPhase: null,
        chunkIndex: null,
        summary: `reaped: stuck in 'paused' >${PAUSED_THRESHOLD_MINUTES} min — continuation never landed`,
      },
    });

    if (runningResult.count > 0 || pausedResult.count > 0) {
      logger.warn(
        { runningReaped: runningResult.count, pausedReaped: pausedResult.count },
        '[drive.reaper] reaped stale sync_runs',
      );
    }

    return {
      runningReaped: runningResult.count,
      pausedReaped: pausedResult.count,
    };
  } catch (err) {
    logger.error({ err }, '[drive.reaper] reaper query failed (non-fatal)');
    return { runningReaped: 0, pausedReaped: 0 };
  }
}
