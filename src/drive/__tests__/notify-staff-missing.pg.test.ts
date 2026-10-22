/**
 * notify's "reviewer staff missing" diagnostic against Postgres: the JSON
 * path lookup (payload.proposalId) that keeps it to one drive_scan_logs row
 * per proposal across notify runs. Mocks cannot show that Prisma's path
 * filter matches what writeScanLog stored, so this file runs the real query.
 *
 * Skipped unless H8_PG_URL points at a disposable database built from GUB's
 * migration chain (the same recipe as snapshot-index.pg.test.ts):
 *
 *   docker run --rm -d --name h8-pg -p 55482:5432 -e POSTGRES_PASSWORD=password pgvector/pgvector:pg16
 *   git -C <gcp-universal-backend checkout> archive origin/main prisma | tar -x -C <scratch dir>
 *   DATABASE_URL=postgresql://postgres:password@localhost:55482/postgres \
 *     npx prisma migrate deploy --schema <scratch dir>/prisma/schema.prisma
 *   H8_PG_URL=postgresql://postgres:password@localhost:55482/postgres npx vitest run notify-staff-missing.pg
 *
 * Never point it at a shared database: it reads every pending proposal and
 * deletes the rows of its own test account and staff.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PG_URL = vi.hoisted(() => {
  const url = process.env['H8_PG_URL'];
  if (url) process.env['DATABASE_URL'] = url;
  return url;
});
const m = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('../../config', () => ({
  config: { DRIVE_PROPOSAL_TTL_DAYS: 14, GUB_ADMIN_BASE_URL: 'https://admin.example.com' },
}));
vi.mock('../../mail', () => ({ mail: { send: m.send, driverName: 'test' } }));

import { prisma } from '../../prisma';
import { notifyReviewers } from '../notify';

const STAFF_ID = '00000000-0000-4000-a000-0000000008a1';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000008b1';
const RUN_1 = '00000000-0000-4000-a000-0000000008c1';
const RUN_2 = '00000000-0000-4000-a000-0000000008c2';
const MESSAGE = 'Reviewer staff missing/inactive at notify time — proposal left pending';

async function propose(id: string, syncRunId: string): Promise<void> {
  await prisma.driveChangeProposal.create({
    data: {
      id,
      syncRunId,
      entityType: 'account',
      accountId: ACCOUNT_ID,
      property: 'budget',
      proposedValue: 5000,
      reviewToken: `h8-token-${id}`,
      reviewerStaffId: STAFF_ID,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  });
}

async function staffMissingRows() {
  return prisma.driveScanLog.findMany({
    where: { accountId: ACCOUNT_ID, message: MESSAGE },
    select: { syncRunId: true, payload: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function cleanup(): Promise<void> {
  await prisma.driveScanLog.deleteMany({ where: { accountId: ACCOUNT_ID } });
  await prisma.driveChangeProposal.deleteMany({ where: { accountId: ACCOUNT_ID } });
}

describe.skipIf(!PG_URL)('notify staff-missing diagnostic against Postgres', () => {
  beforeAll(async () => {
    const host = new URL(PG_URL!);
    if (!['localhost', '127.0.0.1'].includes(host.hostname) || host.port === '5432') {
      throw new Error('H8_PG_URL must be a throwaway database on this machine, not port 5432');
    }
    await prisma.staff.upsert({
      where: { id: STAFF_ID },
      create: {
        id: STAFF_ID,
        fullName: 'Notify Test',
        email: 'notify-test@example.com',
        status: 'former',
        startedAt: new Date('2026-01-01'),
      },
      update: { status: 'former' },
    });
    await prisma.account.upsert({
      where: { id: ACCOUNT_ID },
      create: { id: ACCOUNT_ID, name: 'Notify Test Account' },
      update: {},
    });
    // Both drive_change_proposals.sync_run_id and drive_scan_logs.sync_run_id
    // reference sync_runs, so the proposal's run is valid for its log row.
    for (const id of [RUN_1, RUN_2]) {
      await prisma.syncRun.upsert({
        where: { id },
        create: { id, source: 'google_drive' },
        update: {},
      });
    }
  });

  beforeEach(async () => {
    await cleanup();
    m.send.mockReset();
  });

  afterAll(async () => {
    if (!PG_URL) return;
    await cleanup();
    await prisma.account.deleteMany({ where: { id: ACCOUNT_ID } });
    await prisma.syncRun.deleteMany({ where: { id: { in: [RUN_1, RUN_2] } } });
    await prisma.staff.deleteMany({ where: { id: STAFF_ID } });
    await prisma.$disconnect();
  });

  it('logs each proposal once across runs, under its own sync run', async () => {
    const p1 = '00000000-0000-4000-a000-0000000008d1';
    const p2 = '00000000-0000-4000-a000-0000000008d2';
    await propose(p1, RUN_1);
    await propose(p2, RUN_2);

    await notifyReviewers();
    await notifyReviewers();

    const rows = await staffMissingRows();
    expect(rows).toHaveLength(2);
    expect(
      rows.map((r) => [(r.payload as { proposalId: string }).proposalId, r.syncRunId]),
    ).toEqual(
      expect.arrayContaining([
        [p1, RUN_1],
        [p2, RUN_2],
      ]),
    );
    expect(m.send).not.toHaveBeenCalled();

    // A proposal that arrives later gets its row; the logged ones do not repeat.
    const p3 = '00000000-0000-4000-a000-0000000008d3';
    await propose(p3, RUN_2);
    await notifyReviewers();
    const after = await staffMissingRows();
    expect(after).toHaveLength(3);
    expect((after[2]!.payload as { proposalId: string }).proposalId).toBe(p3);
  });

  it('is not fooled by another diagnostic that names the same proposal', async () => {
    const p1 = '00000000-0000-4000-a000-0000000008e1';
    await propose(p1, RUN_1);
    await prisma.driveScanLog.create({
      data: {
        syncRunId: RUN_1,
        accountId: ACCOUNT_ID,
        level: 'warn',
        category: 'diagnostic',
        message:
          'Proposal has no reviewer_staff_id — needs admin routing before it can be reviewed',
        payload: { proposalId: p1 },
      },
    });

    await notifyReviewers();

    expect(await staffMissingRows()).toHaveLength(1);
  });
});
