// Part of the Drive transport layer — config-free like ./retry, so the unit
// suite can exercise it without an environment.
//
// Pacing for the Workspace content APIs (Docs, Slides, Sheets) and People,
// which bypassed every limiter: eight extraction workers could fire them as
// fast as the APIs answered, a 429 burst then failed files outright, and the
// only retry was gaxios' own three quick ones.
//
// Each API has its own per-user quota, so each gets its own pacer. Unlike
// DriveRateLimiter, a pacer spaces call STARTS and does not hold its slot
// for the call's duration: parallel workers keep their parallelism (H2
// changes no concurrency), only the request rate is capped.

import { jitteredDelayMs } from '../backoff';
import { logger } from '../logger';
import { isRateLimitError } from './retry';

export class StartRatePacer {
  readonly minIntervalMs: number;
  private nextStartAt = 0;

  constructor(callsPerSec: number) {
    this.minIntervalMs = Math.ceil(1000 / callsPerSec);
  }

  /** Resolve when this caller may start. The slot is reserved synchronously. */
  async acquire(): Promise<void> {
    const now = Date.now();
    const startAt = Math.max(now, this.nextStartAt);
    this.nextStartAt = startAt + this.minIntervalMs;
    if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));
  }
}

/**
 * Read quotas per minute per user per project (Workspace usage-limits
 * pages): Docs 300, Slides 600, Sheets 60. Paced to ~80–90% of each.
 * People resolution is a handful of cached lookups per run; 1/s is far
 * below any People read quota.
 */
export const workspacePacers = {
  docs: new StartRatePacer(4), // 240/min of 300
  slides: new StartRatePacer(8), // 480/min of 600
  sheets: new StartRatePacer(0.9), // ~54/min of 60 (a workbook costs 2 reads)
  people: new StartRatePacer(1),
} as const;

export type PacedApi = keyof typeof workspacePacers;

const MAX_ATTEMPTS = 5;

/** Nominal 2 s → 4 s → 8 s → 16 s (cap 30 s), jittered — the Drive limiter's schedule. */
function rateLimitBackoffMs(attempt: number): number {
  return jitteredDelayMs(Math.min(2000 * Math.pow(2, attempt - 1), 30_000));
}

/**
 * Run one Workspace call at its API's pace, backing off on rate limits
 * (429, or 403 with a rate-limit reason). Each retry re-acquires a slot.
 * Anything else propagates immediately.
 */
export async function pacedCall<T>(api: PacedApi, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await workspacePacers[api].acquire();
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= MAX_ATTEMPTS) throw err;
      const backoffMs = rateLimitBackoffMs(attempt);
      logger.warn(
        { api, attempt, maxAttempts: MAX_ATTEMPTS, backoffMs },
        '[workspace.pacing] rate-limited — backing off and retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}
