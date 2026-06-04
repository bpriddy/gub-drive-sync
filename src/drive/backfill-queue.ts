/**
 * backfill-queue.ts — drain the drive_backfill_requests queue once.
 *
 * Invoked by the `backfill-pending` mode of main.ts. Mirrors the canonical
 * pattern-A job-runner shape from gub-research-worker (the reference
 * implementation; see project_standalone_job_pattern.md "Enqueue is the
 * trigger" — no Cloud Scheduler).
 *
 * Lifecycle of one Job execution:
 *   1. reclaimStaleRunning() — reset orphaned `running` rows (the previous
 *      Job process died mid-call) back to `pending`. Self-heal, no scheduler.
 *   2. drainQueue() — single serial worker (LLM-bound, parallel makes
 *      cost/latency worse, not better). Loops claim → process → claim
 *      until claimNext() returns null. Then exits.
 *
 * Concurrency: claimNext() uses raw-SQL SELECT … FOR UPDATE SKIP LOCKED
 * inside a Prisma $transaction — the canonical pattern. Lets multiple Job
 * executions race safely if Cloud Run ever overlaps them (single-
 * execution-at-a-time is the operational expectation, but the safety net
 * costs nothing).
 *
 * Retry policy: a row that errors during processing is re-queued with
 * exponential backoff (60s → 120s → 240s, capped at 30min) and stays
 * eligible for the next claim cycle WITHIN THIS Job execution OR a future
 * one. After MAX_ATTEMPTS the row is marked terminal-failed; the operator
 * resolves it through the UI (re-queue or investigate). No periodic retry
 * infra — a human is in the loop for permanent failures.
 *
 * Trigger model: this is invoked by `triggerDriveSyncJob({ mode:
 * 'backfill-pending' })` in gub-admin's POST handler when the operator
 * clicks Backfill. There is no Cloud Scheduler — enqueue-as-trigger per
 * the locked Pattern A design.
 */

import { prisma } from '../prisma';
import { summarizeError } from '../progress';
// Engine lives in scripts/ today. Dockerfile copies scripts/ into the
// build stage so dist/scripts/backfill.js exists in the runtime image.
import { runBackfill } from '../../scripts/backfill';

/** Stale-running recovery threshold — see project_drive_sync_architecture.md "Self-healing reapers". */
const STALE_RUNNING_MS = 60 * 60 * 1_000; // 60 minutes
/** Per-invocation drain safety cap. Backstop so a runaway queue can't extend a single Job execution indefinitely. */
const MAX_REQUESTS_PER_INVOCATION = 50;
/** Maximum claim count before a row is marked terminal-failed. Mirrors gub-research-worker. */
const MAX_ATTEMPTS = 3;
/** Exponential backoff base: 60s → 120s → 240s, capped at BACKOFF_MAX_MS. */
const BACKOFF_BASE_MS = 60 * 1_000;
const BACKOFF_MAX_MS = 30 * 60 * 1_000;
const LOG_SUMMARY_TAIL_LINES = 40;
const LOG_SUMMARY_MAX_BYTES = 2_000;

export interface ProcessBackfillQueueResult {
  reclaimed: number;
  processed: number;
  completed: number;
  failed: number;
  retriedLater: number;
  hitMaxRequests: boolean;
}

function tailLogSummary(capture: string[]): string {
  const tail = capture.slice(-LOG_SUMMARY_TAIL_LINES).join('\n');
  if (tail.length <= LOG_SUMMARY_MAX_BYTES) return tail;
  return '…\n' + tail.slice(tail.length - LOG_SUMMARY_MAX_BYTES);
}

function backoffMs(attempts: number): number {
  // attempts=1 (just claimed first time) → 60s
  // attempts=2 → 120s
  // attempts=3 → 240s
  const exp = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(exp, BACKOFF_MAX_MS);
}

/**
 * Reset `running` rows whose `started_at` is older than STALE_RUNNING_MS
 * back to `pending`. Runs once at the start of every Job execution.
 * Mirrors gub-research-worker's reclaimStaleRunning — name kept identical
 * for cross-repo grep-ability.
 */
async function reclaimStaleRunning(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  const res = await prisma.driveBackfillRequest.updateMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    data: {
      status: 'pending',
      errorMessage: 'reclaimed: stale running (worker died mid-call)',
    },
  });
  return res.count;
}

/**
 * Claim the next eligible row atomically. Raw-SQL SELECT … FOR UPDATE
 * SKIP LOCKED inside a Prisma $transaction — the canonical pattern
 * (`project_standalone_job_pattern.md`, mirrored from gub-research-worker
 * src/job-runner.ts). Prisma doesn't expose SKIP LOCKED in its query API.
 *
 * Increments `attempts` and stamps `started_at` as part of the claim
 * transaction — the row is in `running` state when the function returns.
 */
async function claimNext(): Promise<{
  id: string;
  accountId: string;
  scans: number;
  attempts: number;
} | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM drive_backfill_requests
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY requested_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return null;
    const jobId = rows[0]!.id;
    return tx.driveBackfillRequest.update({
      where: { id: jobId },
      data: {
        status: 'running',
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
      select: { id: true, accountId: true, scans: true, attempts: true },
    });
  });
}

type ProcessOutcome =
  | { kind: 'completed' }
  | { kind: 'retried' }
  | { kind: 'failed' };

async function processOne(req: {
  id: string;
  accountId: string;
  scans: number;
  attempts: number;
}): Promise<ProcessOutcome> {
  console.log(
    JSON.stringify({
      msg: 'backfill-queue.processing',
      requestId: req.id,
      accountId: req.accountId,
      scans: req.scans,
      attempts: req.attempts,
    }),
  );
  const captureLog: string[] = [];
  try {
    const result = await runBackfill({
      accountId: req.accountId,
      scans: req.scans,
      all: false,
      newestFirst: false,
      outputPath: null,
      structureOnly: false,
      dryrun: false,
      captureLog,
    });
    await prisma.driveBackfillRequest.update({
      where: { id: req.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        scansDone: result.scansProcessed,
        logSummary: tailLogSummary(captureLog),
        nextAttemptAt: null,
      },
    });
    console.log(
      JSON.stringify({
        msg: 'backfill-queue.completed',
        requestId: req.id,
        scansProcessed: result.scansProcessed,
        durationMs: result.durationMs,
      }),
    );
    return { kind: 'completed' };
  } catch (err) {
    const message = summarizeError(err);
    captureLog.push('', `[engine error attempt ${req.attempts}/${MAX_ATTEMPTS}] ${message}`);

    if (req.attempts >= MAX_ATTEMPTS) {
      // Terminal failure — operator resolves via UI.
      console.error(
        JSON.stringify({
          msg: 'backfill-queue.terminal_failure',
          requestId: req.id,
          attempts: req.attempts,
          error: message,
        }),
      );
      await prisma.driveBackfillRequest
        .update({
          where: { id: req.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            errorMessage: message,
            logSummary: tailLogSummary(captureLog),
            nextAttemptAt: null,
          },
        })
        .catch((updateErr) => {
          console.error(
            JSON.stringify({
              msg: 'backfill-queue.terminal_failure.persist_error',
              requestId: req.id,
              error: updateErr instanceof Error ? updateErr.message : String(updateErr),
            }),
          );
        });
      return { kind: 'failed' };
    }

    // Transient — re-queue with backoff.
    const nextAttemptAt = new Date(Date.now() + backoffMs(req.attempts));
    console.warn(
      JSON.stringify({
        msg: 'backfill-queue.retry_scheduled',
        requestId: req.id,
        attempts: req.attempts,
        nextAttemptAt: nextAttemptAt.toISOString(),
        error: message,
      }),
    );
    await prisma.driveBackfillRequest
      .update({
        where: { id: req.id },
        data: {
          status: 'pending',
          startedAt: null,
          errorMessage: message,
          logSummary: tailLogSummary(captureLog),
          nextAttemptAt,
        },
      })
      .catch((updateErr) => {
        console.error(
          JSON.stringify({
            msg: 'backfill-queue.retry_persist_error',
            requestId: req.id,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          }),
        );
      });
    return { kind: 'retried' };
  }
}

/**
 * Single-invocation drain. Loops claim → process → claim … until either:
 *   - claimNext() returns null (queue empty or all eligible rows already
 *     claimed by a parallel execution, OR backoff-deferred)
 *   - MAX_REQUESTS_PER_INVOCATION is reached (runaway-safety backstop)
 *
 * Returns a structured summary so the Job's outcome log captures what
 * was done.
 */
export async function processBackfillQueue(): Promise<ProcessBackfillQueueResult> {
  const reclaimed = await reclaimStaleRunning();

  const summary: ProcessBackfillQueueResult = {
    reclaimed,
    processed: 0,
    completed: 0,
    failed: 0,
    retriedLater: 0,
    hitMaxRequests: false,
  };

  while (summary.processed < MAX_REQUESTS_PER_INVOCATION) {
    const claimed = await claimNext();
    if (!claimed) break;
    const outcome = await processOne(claimed);
    summary.processed += 1;
    if (outcome.kind === 'completed') summary.completed += 1;
    else if (outcome.kind === 'retried') summary.retriedLater += 1;
    else summary.failed += 1;
  }

  if (summary.processed === MAX_REQUESTS_PER_INVOCATION) {
    summary.hitMaxRequests = true;
  }

  return summary;
}
