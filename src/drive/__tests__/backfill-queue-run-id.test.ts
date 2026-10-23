/**
 * The queue hands the drive_sync_runs row it claimed to the driver, so the
 * scan core can stamp it as drive_sync_run_id. The bootstrap hop is otherwise
 * covered only by the Postgres test, which CI skips.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  runBackfill: vi.fn(),
  runForward: vi.fn(),
  /** Rows the next claims return, in order; an empty queue after them. */
  queue: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../backfill', () => ({ runBackfill: m.runBackfill }));
vi.mock('../../forward/run', () => ({ runForward: m.runForward }));
vi.mock('../../prisma', () => ({
  prisma: {
    driveSyncRun: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async () => ({})),
    },
    // A drain that waits out backoffs asks when the next row is due: none.
    $queryRaw: vi.fn(async () => [{ wait_ms: null }]),
    $transaction: vi.fn(async (claim: (tx: unknown) => Promise<unknown>) => {
      const row = m.queue.shift();
      return claim({
        $queryRaw: vi.fn(async () => (row ? [{ id: row['id'] }] : [])),
        driveSyncRun: { update: vi.fn(async () => row) },
      });
    }),
  },
}));

import { processBackfillQueue } from '../backfill-queue';

const RESULT = {
  scansProcessed: 1,
  filesProcessed: 1,
  durationMs: 1,
  finalCursorYmd: '2026-09-01',
  activeDaysFirst: null,
  activeDaysLast: null,
  activeDaysCount: 0,
  structureOnlyMode: false,
  bootstrapCompleted: true,
};

const row = (id: string, mode: string) => ({
  id,
  accountId: 'acct-1',
  mode,
  attempts: 1,
  allRemaining: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.queue = [];
  m.runBackfill.mockResolvedValue(RESULT);
  m.runForward.mockResolvedValue(RESULT);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the queue hands its run row to the driver', () => {
  it('a bootstrap row reaches the day-walk as driveSyncRunId', async () => {
    m.queue.push(row('run-boot', 'bootstrap'));

    await processBackfillQueue();

    expect(m.runBackfill).toHaveBeenCalledTimes(1);
    expect(m.runBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', driveSyncRunId: 'run-boot' }),
    );
  });

  it('a forward row reaches the forward driver as syncRunId', async () => {
    m.queue.push(row('run-fwd', 'forward'));

    await processBackfillQueue();

    expect(m.runForward).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', syncRunId: 'run-fwd' }),
    );
    expect(m.runBackfill).not.toHaveBeenCalled();
  });
});
