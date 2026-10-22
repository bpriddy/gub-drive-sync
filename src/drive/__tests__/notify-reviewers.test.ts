import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  staffFindUnique: vi.fn(),
  scanLogFindMany: vi.fn(),
  send: vi.fn(),
  writeScanLog: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  config: {
    DRIVE_PROPOSAL_TTL_DAYS: 14,
    GUB_ADMIN_BASE_URL: 'https://admin.example.com',
    GUB_REVIEW_BASE_URL: undefined as string | undefined,
  },
}));

vi.mock('../../prisma', () => ({
  prisma: {
    driveChangeProposal: { findMany: mocks.findMany, updateMany: mocks.updateMany },
    staff: { findUnique: mocks.staffFindUnique },
    driveScanLog: { findMany: mocks.scanLogFindMany },
  },
}));
vi.mock('../../config', () => ({ config: mocks.config }));
vi.mock('../../logger', () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: mocks.loggerError },
}));
vi.mock('../../mail', () => ({
  mail: { send: mocks.send, driverName: 'console' },
}));
vi.mock('../logs', () => ({ writeScanLog: mocks.writeScanLog }));

import { notifyReviewers } from '../notify';

interface Row {
  id: string;
  kind: string;
  proposalGroupId: string | null;
  reviewToken: string;
  reviewerStaffId: string | null;
  reviewerEmail: string | null;
  property: string;
  entityType: string;
  accountId: string | null;
  campaignId: string | null;
  sourceDriveFolderId: string | null;
  syncRunId: string | null;
}

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    kind: 'field_change',
    proposalGroupId: null,
    reviewToken: `tok-${overrides.id}`,
    reviewerStaffId: 'staff-1',
    reviewerEmail: 'stale@example.com',
    property: 'budget',
    entityType: 'account',
    accountId: 'acct-1',
    campaignId: null,
    sourceDriveFolderId: 'folder-1',
    syncRunId: 'run-1',
    ...overrides,
  };
}

const STAFF: Record<
  string,
  { id: string; email: string | null; fullName: string; status: string }
> = {
  'staff-1': { id: 'staff-1', email: 'ada@example.com', fullName: 'Ada Example', status: 'active' },
  'staff-2': { id: 'staff-2', email: 'bob@example.com', fullName: 'Bob Example', status: 'active' },
};

const SENT = { messageId: 'msg-1', driver: 'mailgun', dispatched: true };

beforeEach(() => {
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.updateMany.mockReset().mockResolvedValue({ count: 0 });
  mocks.staffFindUnique
    .mockReset()
    .mockImplementation(async ({ where }: { where: { id: string } }) => STAFF[where.id] ?? null);
  mocks.send.mockReset().mockResolvedValue(SENT);
  mocks.scanLogFindMany.mockReset().mockResolvedValue([]);
  mocks.writeScanLog.mockReset().mockResolvedValue(undefined);
  mocks.loggerInfo.mockReset();
  mocks.loggerWarn.mockReset();
  mocks.loggerError.mockReset();
  mocks.config.DRIVE_PROPOSAL_TTL_DAYS = 14;
  mocks.config.GUB_ADMIN_BASE_URL = 'https://admin.example.com';
  mocks.config.GUB_REVIEW_BASE_URL = undefined;
});

describe('notifyReviewers: query', () => {
  it('selects pending, never-notified proposals oldest first', async () => {
    await notifyReviewers();
    const arg = mocks.findMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ state: 'pending', notifiedAt: null });
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('narrows to one sync run when syncRunId is given', async () => {
    await notifyReviewers({ syncRunId: 'run-7' });
    expect(mocks.findMany.mock.calls[0]![0].where).toEqual({
      state: 'pending',
      notifiedAt: null,
      syncRunId: 'run-7',
    });
  });
});

describe('notifyReviewers: nothing pending', () => {
  it('returns zeros, sends nothing and stamps nothing', async () => {
    const result = await notifyReviewers({ syncRunId: 'run-7' });
    expect(result).toMatchObject({
      ownersEmailed: 0,
      proposalsNotified: 0,
      orphansLogged: 0,
      emailDriver: 'console',
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.writeScanLog).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { syncRunId: 'run-7', orphans: 0 },
      '[drive.notify] no eligible proposals to notify',
    );
  });
});

describe('notifyReviewers: grouping', () => {
  it('sends ONE email per reviewer to the CURRENT staff email, not the cached one', async () => {
    mocks.findMany.mockResolvedValue([
      row({ id: 'p1', reviewerStaffId: 'staff-1' }),
      row({ id: 'p2', reviewerStaffId: 'staff-2' }),
      row({ id: 'p3', reviewerStaffId: 'staff-1' }),
    ]);

    const result = await notifyReviewers();

    expect(result).toMatchObject({ ownersEmailed: 2, proposalsNotified: 3, orphansLogged: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const recipients = mocks.send.mock.calls.map((c) => c[0].to);
    expect(recipients).toEqual([
      { email: 'ada@example.com', name: 'Ada Example' },
      { email: 'bob@example.com', name: 'Bob Example' },
    ]);
    expect(mocks.send.mock.calls[0]![0].tags).toEqual({ 'drive.review_notification': 'staff-1' });
    expect(mocks.send.mock.calls[1]![0].tags).toEqual({ 'drive.review_notification': 'staff-2' });
  });

  it("stamps notified_at only on the proposals in each reviewer's own email", async () => {
    mocks.findMany.mockResolvedValue([
      row({ id: 'p1', reviewerStaffId: 'staff-1' }),
      row({ id: 'p2', reviewerStaffId: 'staff-2' }),
      row({ id: 'p3', reviewerStaffId: 'staff-1' }),
    ]);
    await notifyReviewers();

    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.updateMany.mock.calls[0]![0].where).toEqual({ id: { in: ['p1', 'p3'] } });
    expect(mocks.updateMany.mock.calls[1]![0].where).toEqual({ id: { in: ['p2'] } });
    for (const call of mocks.updateMany.mock.calls) {
      expect(call[0].data.notifiedAt).toBeInstanceOf(Date);
    }
  });

  it('uses the first proposal of the bucket as the entry token', async () => {
    mocks.findMany.mockResolvedValue([
      row({ id: 'p1', reviewToken: 'token-first' }),
      row({ id: 'p2', reviewToken: 'token-second' }),
    ]);
    await notifyReviewers();
    const msg = mocks.send.mock.calls[0]![0];
    expect(msg.text).toContain('https://admin.example.com/drive-review/token-first');
    expect(msg.text).not.toContain('token-second');
  });

  it('summarises field changes and new-entity groups in the subject and body', async () => {
    mocks.findMany.mockResolvedValue([
      row({ id: 'p1', kind: 'field_change' }),
      row({ id: 'p2', kind: 'field_change' }),
      row({ id: 'p3', kind: 'new_entity', proposalGroupId: 'grp-1' }),
      row({ id: 'p4', kind: 'new_entity', proposalGroupId: 'grp-1' }),
      row({ id: 'p5', kind: 'new_entity', proposalGroupId: 'grp-2' }),
      // no group id: not counted as a folder
      row({ id: 'p6', kind: 'new_entity', proposalGroupId: null }),
    ]);
    await notifyReviewers();
    const msg = mocks.send.mock.calls[0]![0];
    // The verb agrees with the summary: plural for counts above 1 and for "X and Y".
    expect(msg.subject).toBe('Drive sync: 2 new folders and 2 changes need your review');
    expect(msg.text).toContain('Hi Ada Example,');
    expect(msg.text).toContain('found 2 new folders and 2 changes for accounts you own');
    expect(msg.html).toContain('<strong>2 new folders and 2 changes</strong>');
  });

  it('uses singular wording for one change and one folder', async () => {
    mocks.findMany.mockResolvedValue([
      row({ id: 'p1', kind: 'field_change' }),
      row({ id: 'p2', kind: 'new_entity', proposalGroupId: 'grp-1' }),
    ]);
    await notifyReviewers();
    expect(mocks.send.mock.calls[0]![0].subject).toBe(
      'Drive sync: 1 new folder and 1 change need your review',
    );
  });

  it.each([
    ['one change', [row({ id: 'p1' })], 'Drive sync: 1 change needs your review'],
    [
      'one new folder',
      [row({ id: 'p1', kind: 'new_entity', proposalGroupId: 'grp-1' })],
      'Drive sync: 1 new folder needs your review',
    ],
    [
      'several changes',
      [row({ id: 'p1' }), row({ id: 'p2' }), row({ id: 'p3' })],
      'Drive sync: 3 changes need your review',
    ],
  ])('agrees the verb with the subject: %s', async (_label, rows, subject) => {
    mocks.findMany.mockResolvedValue(rows);
    await notifyReviewers();
    expect(mocks.send.mock.calls[0]![0].subject).toBe(subject);
  });

  it('falls back to "items" when the bundle holds only other kinds', async () => {
    mocks.findMany.mockResolvedValue([row({ id: 'p1', kind: 'additional_update' })]);
    await notifyReviewers();
    expect(mocks.send.mock.calls[0]![0].subject).toBe('Drive sync: items need your review');
  });

  it('states the configured TTL in text and html', async () => {
    mocks.config.DRIVE_PROPOSAL_TTL_DAYS = 3;
    mocks.findMany.mockResolvedValue([row({ id: 'p1' })]);
    await notifyReviewers();
    const msg = mocks.send.mock.calls[0]![0];
    expect(msg.text).toContain('This link expires in 3 days.');
    expect(msg.html).toContain('This link expires in 3 days.');
  });

  it('escapes the reviewer name in html but not in plain text', async () => {
    mocks.staffFindUnique.mockResolvedValue({
      id: 'staff-1',
      email: 'ada@example.com',
      fullName: 'Ada <b>"O\'Example"</b> & Co',
      status: 'active',
    });
    mocks.findMany.mockResolvedValue([row({ id: 'p1' })]);
    await notifyReviewers();
    const msg = mocks.send.mock.calls[0]![0];
    expect(msg.html).toContain('Hi Ada &lt;b&gt;&quot;O&#39;Example&quot;&lt;/b&gt; &amp; Co,');
    expect(msg.html).not.toContain('<b>');
    expect(msg.text).toContain('Hi Ada <b>"O\'Example"</b> & Co,');
  });
});

describe('notifyReviewers: review URL', () => {
  it('prefers GUB_REVIEW_BASE_URL and strips one trailing slash', async () => {
    mocks.config.GUB_REVIEW_BASE_URL = 'https://review.example.com/';
    mocks.findMany.mockResolvedValue([row({ id: 'p1', reviewToken: 'abc123' })]);
    await notifyReviewers();
    const msg = mocks.send.mock.calls[0]![0];
    expect(msg.text).toContain('  https://review.example.com/drive-review/abc123');
    expect(msg.html).toContain('<a href="https://review.example.com/drive-review/abc123"');
    expect(msg.html).not.toContain('admin.example.com');
  });

  it('falls back to GUB_ADMIN_BASE_URL when no review base URL is set', async () => {
    mocks.config.GUB_ADMIN_BASE_URL = 'https://admin.example.com/';
    mocks.findMany.mockResolvedValue([row({ id: 'p1', reviewToken: 'abc123' })]);
    await notifyReviewers();
    expect(mocks.send.mock.calls[0]![0].text).toContain(
      '  https://admin.example.com/drive-review/abc123',
    );
  });
});

describe('notifyReviewers: orphans', () => {
  it('logs each reviewer-less proposal to drive_scan_logs and never emails it', async () => {
    mocks.findMany.mockResolvedValue([
      row({
        id: 'orph-1',
        reviewerStaffId: null,
        kind: 'new_entity',
        property: 'name',
        accountId: 'acct-5',
        campaignId: 'camp-5',
        sourceDriveFolderId: 'folder-5',
        syncRunId: 'run-5',
      }),
    ]);

    const result = await notifyReviewers();

    expect(result).toMatchObject({ ownersEmailed: 0, proposalsNotified: 0, orphansLogged: 1 });
    expect(mocks.writeScanLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeScanLog).toHaveBeenCalledWith({
      syncRunId: 'run-5',
      accountId: 'acct-5',
      campaignId: 'camp-5',
      level: 'warn',
      category: 'diagnostic',
      message: 'Proposal has no reviewer_staff_id — needs admin routing before it can be reviewed',
      payload: {
        proposalId: 'orph-1',
        kind: 'new_entity',
        property: 'name',
        folderId: 'folder-5',
      },
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("keeps orphans out of a reviewer's email while still notifying the reviewer", async () => {
    mocks.findMany.mockResolvedValue([
      row({ id: 'orph-1', reviewerStaffId: null }),
      row({ id: 'p1', reviewerStaffId: 'staff-1' }),
    ]);
    const result = await notifyReviewers();
    expect(result).toMatchObject({ ownersEmailed: 1, proposalsNotified: 1, orphansLogged: 1 });
    expect(mocks.updateMany.mock.calls[0]![0].where).toEqual({ id: { in: ['p1'] } });
    expect(mocks.send.mock.calls[0]![0].subject).toBe('Drive sync: 1 change needs your review');
  });
});

describe('notifyReviewers: unusable reviewers', () => {
  it.each([
    ['unknown staff id', null],
    [
      'inactive staff',
      { id: 'staff-1', email: 'ada@example.com', fullName: 'Ada', status: 'inactive' },
    ],
    ['staff without email', { id: 'staff-1', email: null, fullName: 'Ada', status: 'active' }],
  ])('skips the batch for %s, logs each proposal and leaves it pending', async (_label, staff) => {
    mocks.staffFindUnique.mockResolvedValue(staff);
    mocks.findMany.mockResolvedValue([
      row({ id: 'p1', accountId: 'acct-1', campaignId: null, syncRunId: 'run-1' }),
      row({ id: 'p2', accountId: 'acct-2', campaignId: 'camp-2', syncRunId: 'run-2' }),
    ]);

    const result = await notifyReviewers();

    expect(result).toMatchObject({ ownersEmailed: 0, proposalsNotified: 0, orphansLogged: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.writeScanLog.mock.calls.map((c) => c[0])).toEqual([
      {
        // Filed under the proposal's own sync run, not under no run at all.
        syncRunId: 'run-1',
        accountId: 'acct-1',
        campaignId: null,
        level: 'warn',
        category: 'diagnostic',
        message: 'Reviewer staff missing/inactive at notify time — proposal left pending',
        payload: { proposalId: 'p1', reviewerStaffId: 'staff-1' },
      },
      {
        syncRunId: 'run-2',
        accountId: 'acct-2',
        campaignId: 'camp-2',
        level: 'warn',
        category: 'diagnostic',
        message: 'Reviewer staff missing/inactive at notify time — proposal left pending',
        payload: { proposalId: 'p2', reviewerStaffId: 'staff-1' },
      },
    ]);
  });

  it('writes the diagnostic once per proposal: later runs skip the ones already logged', async () => {
    mocks.staffFindUnique.mockResolvedValue(null);
    mocks.findMany.mockResolvedValue([row({ id: 'p1' }), row({ id: 'p2' })]);
    mocks.scanLogFindMany.mockResolvedValue([
      { payload: { proposalId: 'p1', reviewerStaffId: 'staff-1' } },
    ]);

    await notifyReviewers();

    expect(mocks.scanLogFindMany).toHaveBeenCalledWith({
      where: {
        level: 'warn',
        category: 'diagnostic',
        message: 'Reviewer staff missing/inactive at notify time — proposal left pending',
        OR: [
          { payload: { path: ['proposalId'], equals: 'p1' } },
          { payload: { path: ['proposalId'], equals: 'p2' } },
        ],
      },
      select: { payload: true },
    });
    expect(mocks.writeScanLog.mock.calls.map((c) => c[0].payload.proposalId)).toEqual(['p2']);
    // The Cloud Logging line still fires every run: the gap is still open.
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { reviewerStaffId: 'staff-1', bucketSize: 2 },
      '[drive.notify] reviewer staff not active or lacks email — skipping batch',
    );
  });

  it('writes nothing when every proposal already carries the diagnostic', async () => {
    mocks.staffFindUnique.mockResolvedValue(null);
    mocks.findMany.mockResolvedValue([row({ id: 'p1' })]);
    mocks.scanLogFindMany.mockResolvedValue([{ payload: { proposalId: 'p1' } }]);
    await notifyReviewers();
    expect(mocks.writeScanLog).not.toHaveBeenCalled();
  });

  it('continues with the next reviewer after skipping an unusable one', async () => {
    mocks.staffFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'staff-1' ? null : STAFF[where.id],
    );
    mocks.findMany.mockResolvedValue([
      row({ id: 'p1', reviewerStaffId: 'staff-1' }),
      row({ id: 'p2', reviewerStaffId: 'staff-2' }),
    ]);
    const result = await notifyReviewers();
    expect(result).toMatchObject({ ownersEmailed: 1, proposalsNotified: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![0].to.email).toBe('bob@example.com');
  });
});

describe('notifyReviewers: send failure', () => {
  it("leaves the failed reviewer's proposals un-stamped and continues to the next reviewer", async () => {
    mocks.send.mockRejectedValueOnce(new Error('mailgun down')).mockResolvedValueOnce(SENT);
    mocks.findMany.mockResolvedValue([
      row({ id: 'p1', reviewerStaffId: 'staff-1' }),
      row({ id: 'p2', reviewerStaffId: 'staff-1' }),
      row({ id: 'p3', reviewerStaffId: 'staff-2' }),
    ]);

    const result = await notifyReviewers();

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ownersEmailed: 1, proposalsNotified: 1 });
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany.mock.calls[0]![0].where).toEqual({ id: { in: ['p3'] } });
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError.mock.calls[0]![0]).toMatchObject({
      reviewerStaffId: 'staff-1',
      bucketSize: 2,
    });
    expect(mocks.loggerError.mock.calls[0]![1]).toBe(
      '[drive.notify] mail dispatch failed — leaving proposals unnotified',
    );
  });

  it('reports zero owners when every send fails', async () => {
    mocks.send.mockRejectedValue(new Error('boom'));
    mocks.findMany.mockResolvedValue([
      row({ id: 'p1', reviewerStaffId: 'staff-1' }),
      row({ id: 'p2', reviewerStaffId: 'staff-2' }),
    ]);
    const result = await notifyReviewers();
    expect(result).toMatchObject({ ownersEmailed: 0, proposalsNotified: 0 });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
