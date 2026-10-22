/**
 * A forward run that fails (cursor held) still prints the run summary, with
 * the per-tag token totals, into its captured log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findAccount: vi.fn(),
  updateAccount: vi.fn(),
  getFileMetadata: vi.fn(),
  queryActivityWindow: vi.fn(),
  processBatch: vi.fn(),
  printPhaseSummary: vi.fn(),
}));

vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn() }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../prisma', () => ({
  prisma: { account: { findUniqueOrThrow: m.findAccount, update: m.updateAccount } },
}));
vi.mock('../../drive/client', () => ({ getFileMetadata: m.getFileMetadata }));
vi.mock('../../drive/notify', () => ({ notifyReviewers: vi.fn() }));
vi.mock('../../backfill/entity', () => ({
  loadEntity: vi.fn(async () => ({ name: 'Account One', accountId: 'acc-1', folderId: 'root-1' })),
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
  printPhaseSummary: m.printPhaseSummary,
  timed: (_phase: string, fn: () => unknown) => fn(),
}));
vi.mock('../activity', async (importActual) => ({
  ...(await importActual<typeof import('../activity')>()),
  queryActivityWindow: m.queryActivityWindow,
}));
vi.mock('../people', () => ({ resolveActors: vi.fn(async () => new Map()) }));
vi.mock('../stats', () => ({ writeRunEditStats: vi.fn(async () => 0) }));

import { runForward } from '../run';

beforeEach(() => {
  vi.clearAllMocks();
  m.findAccount.mockResolvedValue({
    name: 'Account One',
    driveFolderId: 'root-1',
    driveBootstrapCompletedAt: new Date('2026-09-01T00:00:00Z'),
    driveForwardCursorAt: new Date('2026-10-19T00:00:00Z'),
  });
  m.queryActivityWindow.mockResolvedValue([
    {
      fileId: 'f1',
      fileTitle: null,
      timestamp: '2026-10-19T09:00:00Z',
      action: 'edit',
      actorResource: 'people/1',
    },
  ]);
  m.getFileMetadata.mockResolvedValue({
    id: 'f1',
    name: 'f1.gdoc',
    mimeType: 'application/vnd.google-apps.document',
    parents: ['root-1'],
  });
});

describe('runForward run summary', () => {
  it('prints it once when the run succeeds', async () => {
    m.processBatch.mockResolvedValue({
      stage3Failures: 0,
      transientFileErrors: 0,
      snapshotWriteFailures: 0,
      filesErrored: 0,
    });
    await runForward({ accountId: 'acc-1', syncRunId: 'run-1' });
    expect(m.printPhaseSummary).toHaveBeenCalledTimes(1);
  });

  it('prints it once when the run fails and the cursor is held', async () => {
    m.processBatch.mockResolvedValue({
      stage3Failures: 1,
      transientFileErrors: 0,
      snapshotWriteFailures: 0,
      filesErrored: 0,
    });
    await expect(runForward({ accountId: 'acc-1', syncRunId: 'run-1' })).rejects.toThrow(
      'cursor NOT advanced',
    );
    expect(m.printPhaseSummary).toHaveBeenCalledTimes(1);
    expect(m.updateAccount).not.toHaveBeenCalled();
  });
});
