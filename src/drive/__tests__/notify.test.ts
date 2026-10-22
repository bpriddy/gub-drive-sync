/**
 * notify.test.ts — notifyReviewers: when notified_at is stamped, and how
 * proposals without a reviewer are reported.
 *
 *   - notified_at is stamped only when the mail driver reports
 *     dispatched: true; a dry run (dispatched: false) leaves it NULL;
 *   - proposals without a reviewer get ONE warn line per run with per-account
 *     counts, next to the per-proposal drive_scan_logs rows that stay as
 *     they were.
 *
 * The database, the mail service and the scan-log writer are mocked; nothing
 * here crosses a DB constraint.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  findStaff: vi.fn(),
  send: vi.fn(),
  writeScanLog: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config', () => ({
  config: {
    DRIVE_PROPOSAL_TTL_DAYS: 14,
    GUB_REVIEW_BASE_URL: 'https://review.example',
    GUB_ADMIN_BASE_URL: 'https://admin.example',
  },
}));
vi.mock('../../prisma', () => ({
  prisma: {
    driveChangeProposal: { findMany: h.findMany, updateMany: h.updateMany },
    staff: { findUnique: h.findStaff },
  },
}));
vi.mock('../../mail', () => ({ mail: { send: h.send, driverName: 'test-driver' } }));
vi.mock('../logs', () => ({ writeScanLog: h.writeScanLog }));
vi.mock('../../logger', () => ({ logger: h.logger }));

import { notifyReviewers } from '../notify';

const ORPHAN_WARN = '[drive.notify] pending proposals without a reviewer, by account';
const NOT_DISPATCHED =
  '[drive.notify] review email not dispatched (dry run) — proposals left unnotified';
const DISPATCHED = '[drive.notify] review email dispatched';

let seq = 0;
function row(over: { reviewerStaffId: string | null; accountId?: string | null }) {
  seq++;
  return {
    id: `p${seq}`,
    kind: 'field_change',
    proposalGroupId: null,
    reviewToken: `tok${seq}`,
    reviewerEmail: null,
    property: 'status',
    entityType: 'account',
    campaignId: null,
    sourceDriveFolderId: `f${seq}`,
    syncRunId: 'run-1',
    accountId: 'acct-a',
    ...over,
  };
}

function staff(id: string) {
  return { id, email: `${id}@example.com`, fullName: `Staff ${id}`, status: 'active' };
}

/** The messages the logger wrote at the given level. */
function messages(level: 'info' | 'warn'): string[] {
  return h.logger[level].mock.calls.map((c) => c[1] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Implementations set by one test (a rejecting send) must not leak into the next.
  h.send.mockReset();
  h.findMany.mockReset();
  seq = 0;
  h.updateMany.mockResolvedValue({ count: 0 });
  h.findStaff.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(staff(where.id)),
  );
});

describe('notifyReviewers — notified_at follows the driver result', () => {
  it('dispatched: false (dry run) leaves notified_at NULL and counts nothing as notified', async () => {
    h.findMany.mockResolvedValue([row({ reviewerStaffId: 's1' }), row({ reviewerStaffId: 's1' })]);
    h.send.mockResolvedValue({ messageId: null, driver: 'console', dispatched: false });

    const result = await notifyReviewers();

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      ownersEmailed: 0,
      proposalsNotified: 0,
      orphansLogged: 0,
      emailDriver: 'test-driver',
      ownersNotDispatched: 1,
    });
    expect(h.logger.info).toHaveBeenCalledWith(
      { reviewerStaffId: 's1', proposals: 2, driver: 'console' },
      NOT_DISPATCHED,
    );
    expect(messages('info')).not.toContain(DISPATCHED);
  });

  it('dispatched: true stamps notified_at on exactly that email’s proposals', async () => {
    h.findMany.mockResolvedValue([row({ reviewerStaffId: 's1' }), row({ reviewerStaffId: 's1' })]);
    h.send.mockResolvedValue({ messageId: 'm-1', driver: 'mailgun', dispatched: true });

    const result = await notifyReviewers();

    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2'] } },
      data: { notifiedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({
      ownersEmailed: 1,
      proposalsNotified: 2,
      ownersNotDispatched: 0,
    });
    expect(messages('info')).toContain(DISPATCHED);
    expect(messages('info')).not.toContain(NOT_DISPATCHED);
  });

  it('per reviewer: only the dispatched email’s proposals are stamped', async () => {
    h.findMany.mockResolvedValue([
      row({ reviewerStaffId: 's1' }),
      row({ reviewerStaffId: 's2' }),
      row({ reviewerStaffId: 's2' }),
    ]);
    h.send
      .mockResolvedValueOnce({ messageId: null, driver: 'console', dispatched: false })
      .mockResolvedValueOnce({ messageId: 'm-2', driver: 'mailgun', dispatched: true });

    const result = await notifyReviewers();

    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p2', 'p3'] } },
      data: { notifiedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({
      ownersEmailed: 1,
      proposalsNotified: 2,
      ownersNotDispatched: 1,
    });
  });

  it('a throwing driver still leaves notified_at NULL (unchanged)', async () => {
    h.findMany.mockResolvedValue([row({ reviewerStaffId: 's1' })]);
    h.send.mockRejectedValue(new Error('provider down'));

    const result = await notifyReviewers();

    expect(h.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ownersEmailed: 0,
      proposalsNotified: 0,
      ownersNotDispatched: 0,
    });
  });
});

describe('notifyReviewers — proposals without a reviewer', () => {
  it('logs one warn line with per-account counts, and keeps the per-proposal scan logs', async () => {
    h.findMany.mockResolvedValue([
      row({ reviewerStaffId: null, accountId: 'acct-b' }),
      row({ reviewerStaffId: null, accountId: 'acct-a' }),
      row({ reviewerStaffId: null, accountId: 'acct-a' }),
      row({ reviewerStaffId: null, accountId: null }),
    ]);

    const result = await notifyReviewers({ syncRunId: 'run-1' });

    const warns = h.logger.warn.mock.calls.filter((c) => c[1] === ORPHAN_WARN);
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toEqual({
      syncRunId: 'run-1',
      orphans: 4,
      accounts: [
        { accountId: 'acct-a', count: 2 },
        { accountId: 'acct-b', count: 1 },
        { accountId: null, count: 1 },
      ],
    });
    // The existing per-proposal drive_scan_logs rows and the run summary stay.
    expect(h.writeScanLog).toHaveBeenCalledTimes(4);
    expect(h.writeScanLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', category: 'diagnostic' }),
    );
    expect(h.logger.info).toHaveBeenCalledWith(
      { syncRunId: 'run-1', orphans: 4 },
      '[drive.notify] no eligible proposals to notify',
    );
    expect(result).toMatchObject({ orphansLogged: 4, ownersEmailed: 0 });
  });

  it('orphans next to reviewed proposals still get the line', async () => {
    h.findMany.mockResolvedValue([
      row({ reviewerStaffId: 's1' }),
      row({ reviewerStaffId: null, accountId: 'acct-c' }),
    ]);
    h.send.mockResolvedValue({ messageId: 'm-1', driver: 'mailgun', dispatched: true });

    await notifyReviewers();

    expect(h.logger.warn).toHaveBeenCalledWith(
      { syncRunId: null, orphans: 1, accounts: [{ accountId: 'acct-c', count: 1 }] },
      ORPHAN_WARN,
    );
  });

  it('no orphans, no line', async () => {
    h.findMany.mockResolvedValue([row({ reviewerStaffId: 's1' })]);
    h.send.mockResolvedValue({ messageId: 'm-1', driver: 'mailgun', dispatched: true });

    await notifyReviewers();

    expect(messages('warn')).not.toContain(ORPHAN_WARN);
  });
});
