import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { pacedCall, StartRatePacer, workspacePacers } from '../pacing';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('StartRatePacer', () => {
  it('spaces call starts by the interval', async () => {
    const pacer = new StartRatePacer(4); // 250 ms
    const starts: number[] = [];
    const t0 = Date.now();
    const all = Promise.all(
      [1, 2, 3].map(async () => {
        await pacer.acquire();
        starts.push(Date.now() - t0);
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await all;
    expect(starts).toEqual([0, 250, 500]);
  });

  it('does not hold the slot for the call: slow calls still overlap', async () => {
    const pacer = new StartRatePacer(4);
    let inFlight = 0;
    let maxInFlight = 0;
    const slowCall = async () => {
      await pacer.acquire();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2000));
      inFlight--;
    };
    const all = Promise.all([slowCall(), slowCall(), slowCall()]);
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    expect(maxInFlight).toBe(3);
  });
});

describe('pacedCall', () => {
  it('backs off on a rate limit, jittered, and succeeds', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // 2 s × 1.49
    const fn = vi.fn().mockRejectedValueOnce({ code: 429 }).mockResolvedValue('doc');
    const p = pacedCall('docs', fn);
    await vi.advanceTimersByTimeAsync(2979);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBe('doc');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after 5 rate-limited attempts', async () => {
    const fn = vi.fn().mockRejectedValue({ code: 429 });
    const p = pacedCall('slides', fn);
    const assertion = expect(p).rejects.toEqual({ code: 429 });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('passes any other error straight through', async () => {
    const fn = vi.fn().mockRejectedValue({ code: 403, errors: [{ reason: 'forbidden' }] });
    await expect(pacedCall('sheets', fn)).rejects.toMatchObject({ code: 403 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('paces each API to its own quota', () => {
    expect(workspacePacers.docs.minIntervalMs).toBe(250);
    expect(workspacePacers.slides.minIntervalMs).toBe(125);
    expect(workspacePacers.sheets.minIntervalMs).toBe(1112);
    expect(workspacePacers.people.minIntervalMs).toBe(1000);
  });
});
