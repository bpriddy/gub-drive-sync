/**
 * backoff.ts — jitter for retry delays.
 *
 * Every retry loop in the Job used a fixed schedule, so parallel workers
 * that failed together (one 429 burst hits all eight) retried together and
 * collided again. Scaling each delay by a random factor in [0.5, 1.5)
 * spreads them out while keeping the nominal schedule as the mean.
 *
 * Config-free on purpose: imported by the hermetic transport modules.
 */
export function jitteredDelayMs(nominalMs: number, random: () => number = Math.random): number {
  return Math.round(nominalMs * (0.5 + random()));
}
