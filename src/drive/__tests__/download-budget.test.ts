/**
 * ByteBudget: the byte-weighted FIFO budget behind every binary download.
 *
 * Two layers:
 *   1. Scenario tests with gates, one rule each (sharing, exclusivity of heavy
 *      and unknown sizes, strict FIFO, idempotent release, ...).
 *   2. Randomised runs with FAKE downloads — random sizes (unknown, zero,
 *      around the heavy threshold, bigger than the whole budget), arrival times,
 *      durations and failures — judged by an independent observer that never
 *      reads the budget's own counters: the bytes in flight never exceed the
 *      capacity, a heavy file never overlaps anything, nothing starts out of
 *      order, and everything drains. The same is then done end to end through
 *      withDownloadedFile with a faked ./client.
 */

import { describe, it, expect, vi } from 'vitest';

const { downloadMock, cfg } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  cfg: { DOWNLOAD_INFLIGHT_BYTES: 1000, DOWNLOAD_HEAVY_BYTES: 100 },
}));

vi.mock('../client', () => ({ downloadFileBuffer: downloadMock }));
vi.mock('../../config', () => ({ config: cfg }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ByteBudget } from '../download-budget';
import { withDownloadedFile } from '../download';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The state of one acquire(), observable without awaiting it. */
function track(p: Promise<() => void>): { granted: boolean; release: () => void } {
  const state = { granted: false, release: (): void => {} };
  void p.then((release) => {
    state.granted = true;
    state.release = release;
  });
  return state;
}

const newBudget = (): ByteBudget => new ByteBudget({ capacityBytes: 100, heavyBytes: 60 });

describe('ByteBudget scenarios (capacity 100, heavy at 60)', () => {
  it('lets light files share the budget up to the capacity, the next one waits', async () => {
    const b = newBudget();
    const a = track(b.acquire(40));
    const c = track(b.acquire(40));
    const d = track(b.acquire(40)); // 40 + 40 + 40 > 100
    await tick();

    expect([a.granted, c.granted, d.granted]).toEqual([true, true, false]);
    expect(b.inFlightBytes).toBe(80);
    expect(b.active).toBe(2);
    expect(b.queued).toBe(1);

    a.release();
    await tick();
    expect(d.granted).toBe(true);
    expect(b.inFlightBytes).toBe(80);
    expect(b.queued).toBe(0);
  });

  it('makes a heavy file wait for everything to drain, then run alone', async () => {
    const b = newBudget();
    const light = track(b.acquire(10));
    const heavy = track(b.acquire(60)); // at the threshold
    await tick();
    expect(light.granted).toBe(true);
    expect(heavy.granted).toBe(false);

    light.release();
    await tick();
    expect(heavy.granted).toBe(true);
    expect(b.active).toBe(1);
    expect(b.inFlightBytes).toBe(100); // holds the whole budget
  });

  it('never lets two heavy files overlap', async () => {
    const b = newBudget();
    const h1 = track(b.acquire(60));
    const h2 = track(b.acquire(80));
    await tick();
    expect([h1.granted, h2.granted]).toEqual([true, false]);

    h1.release();
    await tick();
    expect(h2.granted).toBe(true);
    expect(b.active).toBe(1);
  });

  it('keeps everything else out while a heavy file holds the budget, even a zero-byte one', async () => {
    const b = newBudget();
    const heavy = track(b.acquire(60));
    const tiny = track(b.acquire(0));
    const small = track(b.acquire(1));
    await tick();
    expect(heavy.granted).toBe(true);
    expect([tiny.granted, small.granted]).toEqual([false, false]);

    heavy.release();
    await tick();
    expect([tiny.granted, small.granted]).toEqual([true, true]);
    expect(b.active).toBe(2);
    expect(b.inFlightBytes).toBe(1);
  });

  it('counts an unknown size as heavy, in both directions', async () => {
    const b = newBudget();
    const light = track(b.acquire(5));
    const unknown = track(b.acquire(null));
    const after = track(b.acquire(5));
    await tick();
    expect([light.granted, unknown.granted, after.granted]).toEqual([true, false, false]);

    light.release();
    await tick();
    expect(unknown.granted).toBe(true);
    expect(b.inFlightBytes).toBe(100);
    expect(after.granted).toBe(false); // excluded while the unknown-size file runs

    unknown.release();
    await tick();
    expect(after.granted).toBe(true);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'counts %s as an unknown size',
    async (bad) => {
      const b = newBudget();
      const first = track(b.acquire(bad));
      const second = track(b.acquire(1));
      await tick();
      expect(first.granted).toBe(true);
      expect(b.inFlightBytes).toBe(100);
      expect(second.granted).toBe(false);
    },
  );

  it('splits light from heavy exactly at the threshold', async () => {
    const b = newBudget();
    const justBelow = track(b.acquire(59)); // light
    const other = track(b.acquire(41)); // light: 59 + 41 = 100 fits
    await tick();
    expect([justBelow.granted, other.granted]).toEqual([true, true]);
    expect(b.inFlightBytes).toBe(100);
    justBelow.release();
    other.release();

    const atThreshold = track(b.acquire(60)); // heavy: alone, whole budget
    const next = track(b.acquire(1));
    await tick();
    expect([atThreshold.granted, next.granted]).toEqual([true, false]);
  });

  it('admits a heavy file bigger than the whole budget (alone), charging only the budget', async () => {
    const b = newBudget();
    const huge = track(b.acquire(5000));
    await tick();
    expect(huge.granted).toBe(true);
    expect(b.inFlightBytes).toBe(100);
    huge.release();
    expect(b.inFlightBytes).toBe(0);
  });

  it('is strictly FIFO: lights queued behind a heavy file do not barge past it', async () => {
    const b = newBudget();
    const running = track(b.acquire(10));
    const heavy = track(b.acquire(60));
    const later = [track(b.acquire(10)), track(b.acquire(10)), track(b.acquire(10))];
    await tick();
    // The later lights would fit next to `running`, but the heavy file is ahead of them.
    expect(heavy.granted).toBe(false);
    expect(later.map((t) => t.granted)).toEqual([false, false, false]);

    running.release();
    await tick();
    expect(heavy.granted).toBe(true);
    expect(later.map((t) => t.granted)).toEqual([false, false, false]);

    heavy.release();
    await tick();
    expect(later.map((t) => t.granted)).toEqual([true, true, true]);
    expect(b.inFlightBytes).toBe(30);
  });

  it('does not starve a heavy file behind a steady stream of light ones', async () => {
    const b = newBudget();
    let lightsStarted = 0;
    let lightsStartedWhenHeavyRan = -1;

    const first = track(b.acquire(10));
    const heavy = b.acquire(60).then((release) => {
      lightsStartedWhenHeavyRan = lightsStarted;
      return release;
    });
    // 30 lights keep arriving, each short-lived, while the first light is still running.
    const stream = Array.from({ length: 30 }, async () => {
      const release = await b.acquire(10);
      lightsStarted++;
      await tick();
      release();
    });

    await tick();
    first.release();
    const releaseHeavy = await heavy;
    // None of the 30 later lights got in ahead of the heavy file.
    expect(lightsStartedWhenHeavyRan).toBe(0);
    releaseHeavy();
    await Promise.all(stream);
    expect(lightsStarted).toBe(30);
    expect(b.inFlightBytes).toBe(0);
  });

  it('makes release idempotent: a second release changes nothing and frees nobody else', async () => {
    const b = newBudget();
    const a = track(b.acquire(45));
    const c = track(b.acquire(45));
    const waiter = track(b.acquire(59)); // light, but 45 + 59 > 100
    await tick();
    expect(waiter.granted).toBe(false);

    a.release();
    a.release();
    a.release();
    await tick();

    expect(b.inFlightBytes).toBe(45); // only `c` is left; not 0, not negative
    expect(b.active).toBe(1);
    expect(waiter.granted).toBe(false); // a double release must not let it in

    c.release();
    await tick();
    expect(waiter.granted).toBe(true);
    expect(b.inFlightBytes).toBe(59);
  });

  it('tracks its high-water marks', async () => {
    const b = newBudget();
    const a = track(b.acquire(30));
    const c = track(b.acquire(50));
    await tick();
    a.release();
    c.release();
    const heavy = track(b.acquire(60));
    await tick();
    heavy.release();

    expect(b.highWaterBytes).toBe(100); // the heavy file's whole-budget charge
    expect(b.highWaterActive).toBe(2);
    expect(b.inFlightBytes).toBe(0);
    expect(b.active).toBe(0);
  });

  it('rejects settings that could hang or make no sense', () => {
    expect(() => new ByteBudget({ capacityBytes: 100, heavyBytes: 101 })).toThrow(
      /must not exceed/,
    );
    expect(() => new ByteBudget({ capacityBytes: 0, heavyBytes: 1 })).toThrow(RangeError);
    expect(() => new ByteBudget({ capacityBytes: 100, heavyBytes: 0 })).toThrow(RangeError);
    expect(() => new ByteBudget({ capacityBytes: 100.5, heavyBytes: 10 })).toThrow(RangeError);
    expect(() => new ByteBudget({ capacityBytes: 100, heavyBytes: 100 })).not.toThrow();
  });
});

// ── Randomised runs with fake downloads ──────────────────────────────────────

/** Small seeded PRNG (mulberry32) so a failing run can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FakeDownload {
  id: number;
  size: number | null;
  /** Event-loop ticks before the request is made. */
  arrival: number;
  /** Event-loop ticks the fetch + parse takes while holding the reservation. */
  duration: number;
  /** The download fails partway through. */
  fails: boolean;
}

interface Plan {
  capacity: number;
  heavy: number;
  downloads: FakeDownload[];
}

function plan(seed: number): Plan {
  const rand = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const capacity = int(50, 500);
  const heavy = int(Math.max(1, Math.floor(capacity / 10)), capacity);
  const downloads: FakeDownload[] = Array.from({ length: int(5, 40) }, (_, id) => {
    const r = rand();
    let size: number | null;
    if (r < 0.05) size = null;
    else if (r < 0.1) size = 0;
    else if (r < 0.15) size = heavy - 1;
    else if (r < 0.2) size = heavy;
    else if (r < 0.3)
      size = int(heavy, capacity * 3); // heavy, maybe bigger than the budget
    else size = int(1, Math.max(1, heavy - 1));
    return { id, size, arrival: int(0, 6), duration: int(0, 5), fails: rand() < 0.15 };
  });
  return { capacity, heavy, downloads };
}

/**
 * Watches downloads from the outside. Its notion of "heavy" and of what a
 * download costs is derived from the plan alone, never from the budget.
 */
class Observer {
  readonly violations: string[] = [];
  readonly requested: number[] = [];
  readonly started: number[] = [];
  private readonly running = new Map<number, { heavy: boolean; cost: number }>();
  maxCost = 0;
  maxRunning = 0;

  constructor(
    private readonly capacity: number,
    private readonly heavyAt: number,
  ) {}

  isHeavy(size: number | null): boolean {
    return size === null || size >= this.heavyAt;
  }

  request(d: FakeDownload): void {
    this.requested.push(d.id);
  }

  start(d: FakeDownload): void {
    const heavy = this.isHeavy(d.size);
    const cost = heavy ? this.capacity : (d.size as number);
    if (heavy && this.running.size > 0) {
      this.violations.push(`heavy #${d.id} started while ${[...this.running.keys()]} ran`);
    }
    if (!heavy && [...this.running.values()].some((r) => r.heavy)) {
      this.violations.push(`light #${d.id} started during a heavy download`);
    }
    this.running.set(d.id, { heavy, cost });
    const total = [...this.running.values()].reduce((sum, r) => sum + r.cost, 0);
    if (total > this.capacity) {
      this.violations.push(`in flight ${total} > capacity ${this.capacity} at #${d.id}`);
    }
    this.maxCost = Math.max(this.maxCost, total);
    this.maxRunning = Math.max(this.maxRunning, this.running.size);
    this.started.push(d.id);
  }

  finish(d: FakeDownload): void {
    this.running.delete(d.id);
  }

  get idle(): boolean {
    return this.running.size === 0;
  }
}

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('ByteBudget under randomised fake downloads', () => {
  it('never exceeds its budget, keeps heavy files alone, starts in order and drains', async () => {
    let sawQueueing = 0;
    let sawHeavy = 0;

    for (const seed of SEEDS) {
      const { capacity, heavy, downloads } = plan(seed);
      const budget = new ByteBudget({ capacityBytes: capacity, heavyBytes: heavy });
      const watch = new Observer(capacity, heavy);

      const results = await Promise.allSettled(
        downloads.map(async (d) => {
          await ticks(d.arrival);
          watch.request(d);
          const release = await budget.acquire(d.size);
          watch.start(d);
          try {
            await ticks(d.duration);
            if (d.fails) throw new Error(`download #${d.id} failed`);
          } finally {
            watch.finish(d);
            release();
          }
        }),
      );

      const where = `seed ${seed}`;
      expect(watch.violations, where).toEqual([]);
      expect(watch.maxCost, where).toBeLessThanOrEqual(capacity);
      expect(budget.highWaterBytes, where).toBeLessThanOrEqual(capacity);
      // Strict FIFO: admission order is request order.
      expect(watch.started, where).toEqual(watch.requested);
      // Every download ran (none stuck), and failures released their reservation.
      expect(watch.started.length, where).toBe(downloads.length);
      expect(results.filter((r) => r.status === 'rejected').length, where).toBe(
        downloads.filter((d) => d.fails).length,
      );
      expect(watch.idle, where).toBe(true);
      expect(budget.inFlightBytes, where).toBe(0);
      expect(budget.active, where).toBe(0);
      expect(budget.queued, where).toBe(0);

      if (budget.highWaterActive < downloads.length) sawQueueing++;
      if (downloads.some((d) => watch.isHeavy(d.size))) sawHeavy++;
    }

    // The runs were not vacuous: most of them had to queue, and most had heavy files.
    expect(sawQueueing).toBeGreaterThan(SEEDS.length * 0.8);
    expect(sawHeavy).toBeGreaterThan(SEEDS.length * 0.8);
  });

  it('holds when the same plans run end to end through withDownloadedFile', async () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const { capacity, heavy, downloads } = plan(seed);
      const budget = new ByteBudget({ capacityBytes: capacity, heavyBytes: heavy });
      const watch = new Observer(capacity, heavy);
      const byId = new Map(downloads.map((d) => [String(d.id), d]));

      // The fake Drive: starting the fetch is when the download is "in flight".
      downloadMock.mockReset();
      downloadMock.mockImplementation(async (fileId: string) => {
        const d = byId.get(fileId)!;
        watch.start(d);
        await ticks(d.duration);
        return Buffer.alloc(0);
      });

      const results = await Promise.allSettled(
        downloads.map(async (d) => {
          await ticks(d.arrival);
          watch.request(d);
          return withDownloadedFile(
            { id: String(d.id), size: d.size },
            async () => {
              try {
                await tick(); // the parse, still inside the reservation
                if (d.fails) throw new Error(`parse #${d.id} failed`);
                return d.id;
              } finally {
                // Before withDownloadedFile releases, so the observer never
                // lags behind the budget in the unsafe direction.
                watch.finish(d);
              }
            },
            budget,
          );
        }),
      );

      const where = `seed ${seed}`;
      expect(watch.violations, where).toEqual([]);
      expect(budget.highWaterBytes, where).toBeLessThanOrEqual(capacity);
      expect(watch.started, where).toEqual(watch.requested);
      expect(results.filter((r) => r.status === 'fulfilled').length, where).toBe(
        downloads.filter((d) => !d.fails).length,
      );
      expect(budget.inFlightBytes, where).toBe(0);
      expect(budget.active, where).toBe(0);
    }
  });
});
