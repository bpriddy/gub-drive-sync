/**
 * The queue drain retries a failed row within the same execution. The DB is
 * an in-memory stand-in that mirrors the two queries the drain relies on —
 * "claim the oldest due pending row" and "how long until the next backoff
 * ends" — on a faked clock, so the 60 s / 120 s backoffs pass instantly.
 * The real SQL is exercised against Postgres in backfill-queue.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  accountId: string;
  mode: string;
  status: string;
  attempts: number;
  allRemaining: boolean;
  requestedAt: Date;
  nextAttemptAt: Date | null;
  errorMessage: string | null;
  logSummary: string | null;
  [k: string]: unknown;
}

const db = vi.hoisted(() => ({ rows: [] as Row[] }));
const m = vi.hoisted(() => ({ runForward: vi.fn(), runBackfill: vi.fn() }));

vi.mock('../../prisma', () => {
  const find = (id: string) => {
    const row = db.rows.find((r) => r.id === id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  };
  const update = async ({
    where,
    data,
    select,
  }: {
    where: { id: string };
    data: Record<string, unknown>;
    select?: Record<string, boolean>;
  }) => {
    const row = find(where.id);
    for (const [k, v] of Object.entries(data)) {
      if (k === 'attempts' && typeof v === 'object' && v !== null) {
        row.attempts += (v as { increment: number }).increment;
      } else {
        row[k] = v;
      }
    }
    return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
  };
  const isDue = (r: Row) =>
    r.status === 'pending' && (!r.nextAttemptAt || r.nextAttemptAt.getTime() <= Date.now());
  return {
    prisma: {
      driveSyncRun: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        update,
        count: async ({ where }: { where: { id: { in: string[] }; status: string } }) =>
          db.rows.filter((r) => where.id.in.includes(r.id) && r.status === where.status).length,
      },
      $transaction: async (cb: (tx: unknown) => unknown) =>
        cb({
          // claimNext: oldest due pending row (FOR UPDATE SKIP LOCKED in SQL).
          $queryRaw: async () =>
            db.rows
              .filter(isDue)
              .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
              .slice(0, 1)
              .map((r) => ({ id: r.id })),
          driveSyncRun: { update },
        }),
      // msUntilNextBackoffEnds: MIN over an empty set is one NULL row.
      $queryRaw: async () => {
        const due = db.rows
          .filter((r) => r.status === 'pending' && r.nextAttemptAt)
          .map((r) => r.nextAttemptAt!.getTime())
          .filter((t) => t > Date.now());
        return [{ wait_ms: due.length ? Math.ceil(Math.min(...due) - Date.now()) : null }];
      },
    },
  };
});
vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../forward/run', () => ({ runForward: m.runForward }));
vi.mock('../../backfill', () => ({ runBackfill: m.runBackfill }));

import { processBackfillQueue } from '../backfill-queue';
import { exitCodeFor } from '../../exit-code';

const RESULT = {
  scansProcessed: 1,
  filesProcessed: 3,
  durationMs: 1,
  finalCursorYmd: '2026-10-20',
  activeDaysFirst: null,
  activeDaysLast: null,
  activeDaysCount: 0,
  structureOnlyMode: false,
  bootstrapCompleted: true,
};

function addRow(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: `row-${db.rows.length + 1}`,
    accountId: 'acc-1',
    mode: 'forward',
    status: 'pending',
    attempts: 0,
    allRemaining: false,
    requestedAt: new Date(Date.now() - 1000),
    nextAttemptAt: null,
    errorMessage: null,
    logSummary: null,
    ...over,
  };
  db.rows.push(row);
  return row;
}

/** Drive the drain to completion while fake time passes in 10 s steps. */
async function drain() {
  let settled = false;
  const p = processBackfillQueue().finally(() => {
    settled = true;
  });
  for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(10_000);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T06:00:00Z'));
  db.rows.length = 0;
  m.runForward.mockReset();
  m.runBackfill.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('processBackfillQueue — same-execution retry', () => {
  it('waits out a failed row’s backoff and retries it in the same execution', async () => {
    const row = addRow();
    m.runForward.mockRejectedValueOnce(new Error('transient boom')).mockResolvedValue(RESULT);

    const summary = await drain();

    expect(m.runForward).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      processed: 2,
      completed: 1,
      retriedLater: 1,
      recovered: 1,
      failed: 0,
      backoffWaitMs: 62_000, // 60 s backoff + 2 s slack
    });
    expect(row.status).toBe('completed');
  });

  it('keeps the row’s error readable while it backs off; the success clears it', async () => {
    const row = addRow();
    let errorSeenOnRetry: string | null = null;
    m.runForward.mockRejectedValueOnce(new Error('transient boom')).mockImplementation(async () => {
      errorSeenOnRetry = row.errorMessage;
      return RESULT;
    });

    await drain();

    expect(errorSeenOnRetry).toBe('transient boom');
    expect(row.errorMessage).toBeNull();
  });

  it('runs a persistently failing row to its terminal failure within one execution', async () => {
    const row = addRow();
    m.runForward.mockRejectedValue(new Error('still down'));

    const summary = await drain();

    expect(m.runForward).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ processed: 3, failed: 1, retriedLater: 2, recovered: 0 });
    expect(summary.backoffWaitMs).toBe(62_000 + 122_000);
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toBe('still down');
  });

  it('bounds the total wait: a backoff beyond the budget is left for a later execution', async () => {
    const parked = addRow({ attempts: 1, nextAttemptAt: new Date(Date.now() + 20 * 60_000) });

    const summary = await drain();

    expect(m.runForward).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ processed: 0, backoffWaitMs: 0 });
    expect(parked.status).toBe('pending');
  });

  it('exits at once when nothing is pending', async () => {
    const summary = await drain();
    expect(summary).toMatchObject({ processed: 0, backoffWaitMs: 0 });
  });
});

describe("processBackfillQueue — the execution's exit code", () => {
  it('a row that fails terminally makes the execution exit non-zero', async () => {
    addRow();
    m.runForward.mockRejectedValue(new Error('still down'));
    const summary = await drain();
    expect(summary).toMatchObject({ failed: 1, requeuedAtExit: 0 });
    expect(exitCodeFor('backfill-pending', { ...summary })).toBe(1);
    expect(exitCodeFor('forward-all', { drain: summary })).toBe(1);
  });

  it('a row that recovers within the execution exits zero, and its log keeps the error', async () => {
    const row = addRow();
    m.runForward.mockRejectedValueOnce(new Error('transient boom')).mockResolvedValue(RESULT);
    const summary = await drain();
    expect(summary).toMatchObject({ recovered: 1, failed: 0, requeuedAtExit: 0 });
    expect(exitCodeFor('backfill-pending', { ...summary })).toBe(0);
    expect(row.errorMessage).toBeNull();
    expect(row.logSummary).toContain('[recovered on attempt 2/3; previous error: transient boom]');
  });

  it('a row still re-queued when the wait budget runs out makes it exit non-zero', async () => {
    // A row from an earlier execution, due in 9.5 min, eats most of the
    // 10 min budget; when it then fails, its 60 s backoff no longer fits.
    const row = addRow({ attempts: 1, nextAttemptAt: new Date(Date.now() + 570_000) });
    m.runForward.mockRejectedValue(new Error('down again'));
    const summary = await drain();
    expect(summary).toMatchObject({ processed: 1, retriedLater: 1, requeuedAtExit: 1, failed: 0 });
    expect(row.status).toBe('pending');
    expect(row.errorMessage).toBe('down again');
    expect(exitCodeFor('backfill-pending', { ...summary })).toBe(1);
  });

  it('does not count a row that a concurrent execution finished meanwhile', async () => {
    const row = addRow();
    m.runForward.mockImplementationOnce(async () => {
      // While this execution waits out the backoff, another one claims the
      // row and completes it.
      setTimeout(() => {
        row.status = 'completed';
        row.nextAttemptAt = null;
      }, 20_000);
      throw new Error('transient boom');
    });
    const summary = await drain();
    expect(m.runForward).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ retriedLater: 1, requeuedAtExit: 0 });
    expect(exitCodeFor('backfill-pending', { ...summary })).toBe(0);
  });
});
