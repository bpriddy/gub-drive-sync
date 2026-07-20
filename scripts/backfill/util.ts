// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
// ── Concurrency helper ───────────────────────────────────────────────────────
//
// Worker-pool over an array. N workers race for the next index from a
// shared counter (race-safe because JS is single-threaded at await
// boundaries). Results land in the right slot by index, so the returned
// array preserves input order despite non-deterministic completion order.
//
// Used by processBatch's per-entity distill+synth+write loop. Each entity
// owns a discrete status_markdown row — workers never touch the same row,
// so parallel writes are safe. See SYNTH_CONCURRENCY in config.ts.
//
// The fn is responsible for its own try/catch — uncaught throws will
// propagate and reject the parent Promise.all, killing peer workers.
// Callers that need error-per-item isolation should wrap fn accordingly.

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
