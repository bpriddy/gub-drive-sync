/**
 * runBackfill's day-commit gate for the Drive name index: a day whose
 * snapshot rows failed to write must not be committed — the day-walk never
 * revisits a committed day, so its files would stay stale in the index for
 * good. I/O is mocked at the module boundary; the driver's control flow is
 * real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  config: { SNAPSHOT_WRITE_FAILURE_LIMIT: 0 },
  loadEntity: vi.fn(),
  processBatch: vi.fn(),
  persistCursor: vi.fn(),
}));

vi.mock('../../config', () => ({ config: m.config }));
vi.mock('../../prisma', () => ({ prisma: {} }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../entity', () => ({ loadEntity: m.loadEntity }));
vi.mock('../structure-stage', () => ({
  resolveAccountStructure: vi.fn(async () => ({
    attributor: () => null,
    nameDirectory: null,
    familyByCampaignId: null,
    folderPathById: new Map(),
  })),
}));
vi.mock('../days', async (importActual) => ({
  ...(await importActual<typeof import('../days')>()),
  persistCursor: m.persistCursor,
  persistBootstrapFilesCache: vi.fn(),
}));
vi.mock('../../scan/process-batch', () => ({ processBatch: m.processBatch }));
vi.mock('../../scan/output', () => ({
  log: vi.fn(),
  rule: (t: string) => t,
  fmtMs: (n: number) => `${n}ms`,
  setOutputFile: vi.fn(),
  getLogCapture: () => null,
  setLogCapture: vi.fn(),
}));
vi.mock('../../scan/timing', () => ({
  resetPhaseTimer: vi.fn(),
  printPhaseSummary: vi.fn(),
  timed: (_phase: string, fn: () => unknown) => fn(),
}));

import { runBackfill } from '../run';

// One cached active day: chunk 2..N of a bootstrap chain reads the file list
// from the account row, so no Drive discovery is involved.
const DAY = '2026-09-01';
const FILE = {
  id: 'f1',
  name: 'Brief.pdf',
  mimeType: 'application/pdf',
  parents: ['root-1'],
  path: 'Acme / Brief.pdf',
  modifiedTime: `${DAY}T10:00:00.000Z`,
  modifiedByEmail: null,
  createdTime: null,
  size: 1,
  isFolder: false,
};

const outcome = (snapshotWriteFailures: number) => ({
  stage3Failures: 0,
  snapshotWriteFailures,
  synthesized: [],
});

const run = (over: { dryrun?: boolean } = {}) =>
  runBackfill({
    accountId: 'acc-1',
    newestFirst: false,
    outputPath: null,
    structureOnly: false,
    dryrun: false,
    ...over,
  });

beforeEach(() => {
  for (const fn of [m.loadEntity, m.processBatch, m.persistCursor]) fn.mockReset();
  m.config.SNAPSHOT_WRITE_FAILURE_LIMIT = 0;
  m.loadEntity.mockResolvedValue({
    type: 'account',
    id: 'acc-1',
    name: 'Acme',
    folderId: 'root-1',
    accountId: 'acc-1',
    driveBootstrapCursor: null,
    driveBootstrapFiles: { files: [FILE], activeDates: [{ date: DAY, files: [FILE] }] },
  });
  m.processBatch.mockResolvedValue(outcome(0));
});

describe('runBackfill snapshot gate', () => {
  it('commits the day when every index row landed', async () => {
    await run();
    expect(m.persistCursor).toHaveBeenCalledWith('acc-1', DAY, true);
  });

  it('fails the day and holds the cursor when an index row failed to write', async () => {
    m.processBatch.mockResolvedValue(outcome(1));

    await expect(run()).rejects.toThrow(
      /1 snapshot write failure\(s\) on 2026-09-01 \(SNAPSHOT_WRITE_FAILURE_LIMIT=0\) — day NOT committed/,
    );
    expect(m.persistCursor).not.toHaveBeenCalled();
  });

  it('tolerates failures up to SNAPSHOT_WRITE_FAILURE_LIMIT and commits the day', async () => {
    m.config.SNAPSHOT_WRITE_FAILURE_LIMIT = 1;
    m.processBatch.mockResolvedValue(outcome(1));

    await run();

    expect(m.persistCursor).toHaveBeenCalledWith('acc-1', DAY, true);
  });

  it('never gates a dryrun, which writes no rows', async () => {
    m.processBatch.mockResolvedValue(outcome(1));
    await expect(run({ dryrun: true })).resolves.toMatchObject({ scansProcessed: 1 });
    expect(m.persistCursor).not.toHaveBeenCalled();
  });
});
