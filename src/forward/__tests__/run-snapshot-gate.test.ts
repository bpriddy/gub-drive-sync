/**
 * runForward's snapshot gate: a drive_file_snapshots row that failed to write
 * leaves its file stale in the Drive name index, so the run must fail and hold
 * the account cursor — the queue retry re-runs the window — unless
 * SNAPSHOT_WRITE_FAILURE_LIMIT allows the loss. Also checked here: the driver
 * hands its queue row id to the scan core. I/O is mocked at the module
 * boundary; the driver's control flow is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  config: { SNAPSHOT_WRITE_FAILURE_LIMIT: 0 },
  findAccount: vi.fn(),
  updateAccount: vi.fn(),
  getFileMetadata: vi.fn(),
  queryActivityWindow: vi.fn(),
  processBatch: vi.fn(),
  notifyReviewers: vi.fn(),
  writeRunEditStats: vi.fn(),
}));

vi.mock('../../config', () => ({ config: m.config }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn() }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../prisma', () => ({
  prisma: { account: { findUniqueOrThrow: m.findAccount, update: m.updateAccount } },
}));
vi.mock('../../drive/client', () => ({ getFileMetadata: m.getFileMetadata }));
vi.mock('../../drive/notify', () => ({ notifyReviewers: m.notifyReviewers }));
vi.mock('../../backfill/entity', () => ({
  loadEntity: vi.fn(async () => ({ name: 'Account One', accountId: 'acc-1' })),
}));
vi.mock('../../backfill/structure-stage', () => ({
  resolveAccountStructure: vi.fn(async () => ({
    attributor: null,
    nameDirectory: null,
    folderPathById: new Map(),
    familyByCampaignId: null,
  })),
}));
vi.mock('../../scan/process-batch', () => ({ processBatch: m.processBatch }));
vi.mock('../../scan/output', () => ({
  log: vi.fn(),
  rule: (t: string) => t,
  fmtMs: (n: number) => `${n}ms`,
  getLogCapture: () => null,
  setLogCapture: vi.fn(),
}));
vi.mock('../../scan/timing', () => ({
  resetPhaseTimer: vi.fn(),
  printPhaseSummary: vi.fn(),
  timed: (_phase: string, fn: () => unknown) => fn(),
}));
vi.mock('../activity', async (importActual) => ({
  ...(await importActual<typeof import('../activity')>()),
  queryActivityWindow: m.queryActivityWindow,
}));
vi.mock('../people', () => ({ resolveActors: vi.fn(async () => new Map()) }));
vi.mock('../stats', () => ({ writeRunEditStats: m.writeRunEditStats }));

import { runForward } from '../run';

const CURSOR = new Date('2026-10-19T00:00:00Z');

function meta(id: string) {
  return {
    id,
    name: `${id}.gdoc`,
    mimeType: 'application/vnd.google-apps.document',
    parents: ['root-1'],
  };
}

const outcome = (snapshotWriteFailures: number) => ({ stage3Failures: 0, snapshotWriteFailures });

const run = () => runForward({ accountId: 'acc-1', syncRunId: 'run-1' });
const cursorAdvanced = () =>
  m.updateAccount.mock.calls.some(
    ([arg]) => (arg as { data?: { driveForwardCursorAt?: unknown } }).data?.driveForwardCursorAt,
  );

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === 'function') fn.mockReset();
  m.config.SNAPSHOT_WRITE_FAILURE_LIMIT = 0;
  m.findAccount.mockResolvedValue({
    name: 'Account One',
    driveFolderId: 'root-1',
    driveBootstrapCompletedAt: new Date('2026-10-01T00:00:00Z'),
    driveForwardCursorAt: CURSOR,
  });
  m.queryActivityWindow.mockResolvedValue([
    {
      fileId: 'f1',
      fileTitle: 'f1',
      timestamp: '2026-10-19T09:00:00Z',
      action: 'edit',
      actorResource: null,
    },
    {
      fileId: 'f2',
      fileTitle: 'f2',
      timestamp: '2026-10-19T09:05:00Z',
      action: 'edit',
      actorResource: null,
    },
  ]);
  m.getFileMetadata.mockImplementation(async (id: string) => meta(id));
  m.processBatch.mockResolvedValue(outcome(0));
  m.writeRunEditStats.mockResolvedValue(0);
  m.notifyReviewers.mockResolvedValue({});
});

describe('runForward snapshot gate', () => {
  it('advances the cursor when every index row landed', async () => {
    await run();
    expect(cursorAdvanced()).toBe(true);
  });

  it('fails the run and holds the cursor when an index row failed to write', async () => {
    m.processBatch.mockResolvedValue(outcome(1));

    await expect(run()).rejects.toThrow(
      /1 snapshot write failure\(s\) \(SNAPSHOT_WRITE_FAILURE_LIMIT=0\) — cursor NOT advanced/,
    );

    expect(cursorAdvanced()).toBe(false);
    // The retry re-runs this window, so nothing downstream of the gate may
    // have committed for it: no edit stats, no reviewer fan-out.
    expect(m.writeRunEditStats).not.toHaveBeenCalled();
    expect(m.notifyReviewers).not.toHaveBeenCalled();
  });

  it('tolerates failures up to SNAPSHOT_WRITE_FAILURE_LIMIT and advances', async () => {
    m.config.SNAPSHOT_WRITE_FAILURE_LIMIT = 1;
    m.processBatch.mockResolvedValue(outcome(1));

    await run();

    expect(cursorAdvanced()).toBe(true);
  });

  it('still fails once the failures exceed the limit', async () => {
    m.config.SNAPSHOT_WRITE_FAILURE_LIMIT = 1;
    m.processBatch.mockResolvedValue(outcome(2));

    await expect(run()).rejects.toThrow(
      /2 snapshot write failure\(s\) \(SNAPSHOT_WRITE_FAILURE_LIMIT=1\) — cursor NOT advanced/,
    );
    expect(cursorAdvanced()).toBe(false);
  });
});

describe('runForward run id', () => {
  it('hands the drive_sync_runs row id to the scan core for its rows to carry', async () => {
    await run();

    expect(m.processBatch).toHaveBeenCalledTimes(1);
    expect(m.processBatch).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ application: 'propose', driveSyncRunId: 'run-1' }),
    );
  });
});
