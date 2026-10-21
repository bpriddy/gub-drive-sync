/**
 * printPhaseSummary ends with the process's peak memory, as a human line in the
 * run summary (the part captured into the run's log) and as a structured line
 * for querying. Both drivers call printPhaseSummary last, so that is where the
 * peak lands. The summary also labels the bootstrap files cache read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { infoLog } = vi.hoisted(() => ({ infoLog: vi.fn() }));

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: infoLog, warn: vi.fn(), error: vi.fn() },
}));

import { setLogCapture } from '../output';
import { printPhaseSummary, resetPhaseTimer, timed } from '../timing';

const PEAK_LINE =
  /^ {2}Peak memory: RSS (\d+) MiB \(process high-water mark\), heap used (\d+) MiB now$/;

let lines: string[];

beforeEach(() => {
  lines = [];
  infoLog.mockReset();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  setLogCapture(lines);
});

afterEach(() => {
  setLogCapture(null);
  vi.restoreAllMocks();
});

describe('printPhaseSummary phase labels', () => {
  it('names the bootstrap files cache read, now timed apart from loadEntity', async () => {
    resetPhaseTimer();
    await timed('files_cache_load', async () => {});

    printPhaseSummary(1500);

    expect(lines.some((l) => l.startsWith('  Files cache load (DB)'))).toBe(true);
    expect(lines.some((l) => l.includes('files_cache_load'))).toBe(false);
  });
});

describe('printPhaseSummary peak memory', () => {
  it('prints the process peak RSS and the current heap as the last line of the summary', async () => {
    resetPhaseTimer();
    await timed('setup', async () => {});

    const before = process.resourceUsage().maxRSS;
    printPhaseSummary(1500);
    const after = process.resourceUsage().maxRSS;

    // The existing summary is still there, and the peak line is the last thing in it.
    expect(lines.some((l) => l.includes('Phase timing (this scan)'))).toBe(true);
    expect(lines.some((l) => l.includes('Wall-clock total'))).toBe(true);
    const last = lines[lines.length - 1]!;
    const match = PEAK_LINE.exec(last);
    expect(match, `last summary line was: ${last}`).not.toBeNull();

    // The MiB figure is the kernel's high-water mark (read in KiB), rounded.
    const rssMiB = Number(match![1]);
    expect(rssMiB).toBeGreaterThanOrEqual(Math.round(before / 1024));
    expect(rssMiB).toBeLessThanOrEqual(Math.round(after / 1024));
    expect(rssMiB).toBeGreaterThan(0);
    expect(Number(match![2])).toBeGreaterThan(0);
  });

  it('also writes a structured line with byte values', async () => {
    resetPhaseTimer();
    await timed('setup', async () => {});

    const before = process.resourceUsage().maxRSS * 1024;
    printPhaseSummary(1500);
    const after = process.resourceUsage().maxRSS * 1024;

    expect(infoLog).toHaveBeenCalledTimes(1);
    const [fields, message] = infoLog.mock.calls[0]!;
    expect(message).toBe('[drive.memory] run peak');
    expect(Object.keys(fields).sort()).toEqual(['heapUsedBytes', 'peakRssBytes']);
    // maxRSS is reported in KiB; the structured line carries bytes.
    expect(fields.peakRssBytes % 1024).toBe(0);
    expect(fields.peakRssBytes).toBeGreaterThanOrEqual(before);
    expect(fields.peakRssBytes).toBeLessThanOrEqual(after);
    expect(fields.heapUsedBytes).toBeGreaterThan(0);
    expect(fields.peakRssBytes).toBeGreaterThanOrEqual(fields.heapUsedBytes);
  });

  it('stays quiet when no phase was timed, like the rest of the summary', () => {
    resetPhaseTimer();

    printPhaseSummary(10);

    expect(lines).toEqual([]);
    expect(infoLog).not.toHaveBeenCalled();
  });
});
