/**
 * The drain's real SQL against a throwaway Postgres: the claim (FOR UPDATE
 * SKIP LOCKED, next_attempt_at <= NOW()) and the backoff-wait query (DB
 * clock, MIN over an empty set). Skipped unless H2_PG_URL points at a
 * disposable database with the gub-schemas schema pushed, e.g.
 *
 *   docker run --rm -d --name h2-pg -p 55442:5432 -e POSTGRES_PASSWORD=password pgvector/pgvector:pg16
 *   DATABASE_URL=postgresql://postgres:password@localhost:55442/postgres npx prisma db push --skip-generate
 *   H2_PG_URL=postgresql://postgres:password@localhost:55442/postgres npx vitest run backfill-queue.pg
 *
 * Never point it at a shared database: it deletes every drive_sync_runs row.
 * Time is simulated: the injected sleep moves every next_attempt_at back by
 * the slept amount instead of waiting.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PG_URL = vi.hoisted(() => {
  const url = process.env['H2_PG_URL'];
  if (url) process.env['DATABASE_URL'] = url;
  return url;
});
const m = vi.hoisted(() => ({ runForward: vi.fn() }));

vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../forward/run', () => ({ runForward: m.runForward }));
vi.mock('../../backfill', () => ({ runBackfill: vi.fn() }));

import { prisma } from '../../prisma';
import { processBackfillQueue } from '../backfill-queue';

const STAFF_ID = '00000000-0000-4000-a000-0000000000a1';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000000b1';

const RESULT = {
  scansProcessed: 1,
  filesProcessed: 1,
  durationMs: 1,
  finalCursorYmd: '2026-10-20',
  activeDaysFirst: null,
  activeDaysLast: null,
  activeDaysCount: 0,
  structureOnlyMode: false,
  bootstrapCompleted: true,
};

/** "Sleep" by moving the backoffs into the past — the DB clock keeps running. */
async function shiftClock(ms: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE drive_sync_runs
    SET next_attempt_at = next_attempt_at - (${ms}::int * interval '1 millisecond')
    WHERE next_attempt_at IS NOT NULL
  `;
}

describe.skipIf(!PG_URL)('backfill queue drain against Postgres', () => {
  beforeAll(async () => {
    await prisma.staff.upsert({
      where: { id: STAFF_ID },
      create: {
        id: STAFF_ID,
        fullName: 'Queue Test',
        email: 'queue-test@example.com',
        startedAt: new Date('2026-01-01'),
      },
      update: {},
    });
    await prisma.account.upsert({
      where: { id: ACCOUNT_ID },
      create: { id: ACCOUNT_ID, name: 'Queue Test Account' },
      update: {},
    });
  });

  beforeEach(async () => {
    await prisma.driveSyncRun.deleteMany({});
    m.runForward.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.$disconnect();
  });

  it('retries a failed row in the same execution once its backoff ends', async () => {
    const row = await prisma.driveSyncRun.create({
      data: { accountId: ACCOUNT_ID, mode: 'forward', requestedBy: STAFF_ID },
    });
    m.runForward.mockRejectedValueOnce(new Error('transient boom')).mockResolvedValue(RESULT);

    const summary = await processBackfillQueue({ sleep: shiftClock });

    expect(summary).toMatchObject({ processed: 2, completed: 1, retriedLater: 1, recovered: 1 });
    // 60 s backoff measured on the DB clock, + 2 s slack.
    expect(summary.backoffWaitMs).toBeGreaterThan(61_000);
    expect(summary.backoffWaitMs).toBeLessThanOrEqual(62_000);
    const after = await prisma.driveSyncRun.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: 'completed', attempts: 2, errorMessage: null });
  });

  it('measures a far backoff correctly and does not wait past the budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await prisma.driveSyncRun.create({
      data: {
        accountId: ACCOUNT_ID,
        mode: 'forward',
        requestedBy: STAFF_ID,
        attempts: 1,
        nextAttemptAt: new Date(Date.now() + 20 * 60_000),
      },
    });

    const summary = await processBackfillQueue({ sleep: shiftClock });

    expect(summary).toMatchObject({ processed: 0, backoffWaitMs: 0 });
    expect(m.runForward).not.toHaveBeenCalled();
    const line = warn.mock.calls
      .map(([l]) => JSON.parse(String(l)) as { msg: string; nextDueInMs?: number })
      .find((l) => l.msg === 'backfill-queue.backoff_wait_budget_exhausted');
    expect(line?.nextDueInMs).toBeGreaterThan(20 * 60_000 - 5_000);
    expect(line?.nextDueInMs).toBeLessThanOrEqual(20 * 60_000);
  });

  it('exits at once on an empty queue (MIN over no rows is NULL)', async () => {
    const sleep = vi.fn(shiftClock);
    const summary = await processBackfillQueue({ sleep });
    expect(summary).toMatchObject({ processed: 0, backoffWaitMs: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });
});
