import { describe, expect, it } from 'vitest';
import { drainCountsFor, exitCodeFor } from '../exit-code';

const drain = (failed: number, requeuedAtExit: number) => ({
  processed: 3,
  completed: 1,
  failed,
  retriedLater: 2,
  recovered: 1,
  requeuedAtExit,
});

describe('exitCodeFor', () => {
  it('exits 1 when a drain left a row failed or still re-queued', () => {
    expect(exitCodeFor('backfill-pending', drain(1, 0))).toBe(1);
    expect(exitCodeFor('backfill-pending', drain(0, 1))).toBe(1);
    expect(exitCodeFor('forward-all', { enqueued: 2, drain: drain(0, 1) })).toBe(1);
  });

  it('exits 0 for a clean drain, recoveries included', () => {
    expect(exitCodeFor('backfill-pending', drain(0, 0))).toBe(0);
    expect(exitCodeFor('forward-all', { enqueued: 0, drain: drain(0, 0) })).toBe(0);
  });

  it('leaves every other mode at 0', () => {
    expect(exitCodeFor('poll', { failed: 3 })).toBe(0);
    expect(exitCodeFor('notify', {})).toBe(0);
    expect(exitCodeFor('forward-all', {})).toBe(0);
  });

  it('reports the counts behind the code', () => {
    expect(drainCountsFor('forward-all', { drain: drain(2, 1) })).toEqual({
      failed: 2,
      requeuedAtExit: 1,
    });
  });
});
