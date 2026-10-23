/**
 * runBackfill and the bootstrap files cache: the cache is read lazily and
 * only on the bootstrap path, from the cache column alone, in either on-disk
 * format; a miss (no cache, or one we cannot use) falls back to discovery and
 * writes the current format.
 *
 * Everything around the cache read is mocked (the account row, structure
 * stage, Drive discovery, per-file processing); the cache code in days.ts and
 * the engine in run.ts are the real ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraversedFile } from '../../drive/types';
import type { EntityCtx } from '../../scan/batch-types';
import type { Args } from '../args';

// config.ts validates the environment on import; the driver pulls it in.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const m = vi.hoisted(() => ({
  prisma: {
    account: { findUnique: vi.fn(), update: vi.fn() },
    campaignPiece: { findMany: vi.fn() },
  },
  loadEntity: vi.fn(),
  gatherFilesAuto: vi.fn(),
  gatherFilesRecursive: vi.fn(),
  resolveAccountStructure: vi.fn(),
  runStructureOnly: vi.fn(),
  processBatch: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../../prisma', () => ({ prisma: m.prisma }));
vi.mock('../entity', () => ({ loadEntity: m.loadEntity }));
vi.mock('../discovery', () => ({
  gatherFilesAuto: m.gatherFilesAuto,
  gatherFilesRecursive: m.gatherFilesRecursive,
}));
vi.mock('../structure-stage', () => ({ resolveAccountStructure: m.resolveAccountStructure }));
vi.mock('../structure-mode', () => ({ runStructureOnly: m.runStructureOnly }));
vi.mock('../../scan/process-batch', () => ({ processBatch: m.processBatch }));
// Timing is irrelevant here; a pass-through keeps this file independent of it.
vi.mock('../../scan/timing', () => ({
  resetPhaseTimer: vi.fn(),
  printPhaseSummary: vi.fn(),
  timed: <T>(_phase: string, fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock('../../scan/output', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scan/output')>()),
  log: m.log,
}));

import { runBackfill } from '../run';

function file(n: number, modified: string): TraversedFile {
  return {
    id: `file-${n}`,
    name: `Acme brief ${n}.pdf`,
    mimeType: 'application/pdf',
    parents: ['folder-1'],
    path: `Acme / Briefs / Acme brief ${n}.pdf`,
    modifiedTime: `${modified}T10:00:00.000Z`,
    modifiedByEmail: 'ana@example.com',
    createdTime: '2024-01-01T10:00:00.000Z',
    size: 1000 + n,
    isFolder: false,
  };
}

// Day 1 has two files, day 2 one.
const FILES = [file(1, '2024-03-01'), file(2, '2024-03-02'), file(3, '2024-03-01')];
const DAY_1 = ['file-1', 'file-3'];

const V2_COLUMN = {
  version: 2,
  files: FILES,
  activeDates: [
    { date: '2024-03-01', fileIds: DAY_1 },
    { date: '2024-03-02', fileIds: ['file-2'] },
  ],
};
const LEGACY_COLUMN = {
  files: FILES,
  activeDates: [
    { date: '2024-03-01', files: [FILES[0], FILES[2]] },
    { date: '2024-03-02', files: [FILES[1]] },
  ],
};
/** What a column read hands back: fresh objects. */
const column = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

const CTX: EntityCtx = {
  type: 'account',
  id: 'acc-1',
  name: 'Acme',
  folderId: 'folder-acme',
  accountId: 'acc-1',
  accountFolderId: 'folder-acme',
  accountState: {
    status: null,
    account_exec_staff_id: null,
    industry: null,
    primary_contact_name: null,
    primary_contact_email: null,
    notes: null,
  },
  accountName: 'Acme',
  campaignName: null,
  campaignState: null,
  statusMarkdown: null,
  statusSensitiveMarkdown: null,
  driveBootstrapCursor: null,
  driveStructureClassification: null,
  reviewerEmail: null,
  reviewerStaffId: null,
};

const ARGS: Args = {
  accountId: 'acc-1',
  newestFirst: false,
  outputPath: null,
  structureOnly: false,
  dryrun: false,
};

const logged = (): string[] => m.log.mock.calls.map((c) => String(c[0]));

/** The column values written by prisma.account.update, in call order. */
const updates = (): Array<Record<string, unknown>> =>
  m.prisma.account.update.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  for (const fn of [
    m.prisma.account.findUnique,
    m.prisma.account.update,
    m.prisma.campaignPiece.findMany,
    m.loadEntity,
    m.gatherFilesAuto,
    m.gatherFilesRecursive,
    m.resolveAccountStructure,
    m.runStructureOnly,
    m.processBatch,
    m.log,
  ]) {
    fn.mockReset();
  }
  // loadEntity's ctx has no cache in it any more.
  m.loadEntity.mockResolvedValue({ ...CTX });
  m.prisma.account.update.mockResolvedValue({});
  m.resolveAccountStructure.mockResolvedValue({
    attributor: {},
    nameDirectory: {},
    familyByCampaignId: new Map(),
    folderPathById: new Map(),
  });
  m.processBatch.mockResolvedValue({ synthesized: [], stage3Failures: 0 });
  m.gatherFilesAuto.mockResolvedValue(FILES);
});

describe('bootstrap path — lazy cache read', () => {
  it('does not read the cache at all in structure-only mode', async () => {
    const result = await runBackfill({ ...ARGS, structureOnly: true });

    expect(result.structureOnlyMode).toBe(true);
    expect(m.runStructureOnly).toHaveBeenCalledTimes(1);
    expect(m.prisma.account.findUnique).not.toHaveBeenCalled();
    expect(m.gatherFilesAuto).not.toHaveBeenCalled();
  });

  it('reads the cache column once, resumes from it and skips discovery (version 2)', async () => {
    m.prisma.account.findUnique.mockResolvedValue({ driveBootstrapFiles: column(V2_COLUMN) });

    const result = await runBackfill(ARGS);

    // One extra read, of the cache column only — loadEntity (mocked) did not do it.
    expect(m.prisma.account.findUnique).toHaveBeenCalledTimes(1);
    expect(m.prisma.account.findUnique).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      select: { driveBootstrapFiles: true },
    });
    expect(m.gatherFilesAuto).not.toHaveBeenCalled();
    expect(logged()).toContain('  ✓ Files cache HIT  (3 files, 2 active days)');

    // The first active day past the (empty) cursor is scanned with its files.
    expect(m.processBatch).toHaveBeenCalledTimes(1);
    const [batchFiles, opts] = m.processBatch.mock.calls[0]!;
    expect((batchFiles as TraversedFile[]).map((f) => f.id)).toEqual(DAY_1);
    expect(opts.editedAt).toBe('2024-03-01');
    expect(result).toMatchObject({
      scansProcessed: 1,
      filesProcessed: 2,
      activeDaysCount: 2,
      finalCursorYmd: '2024-03-01',
      bootstrapCompleted: false,
    });
    // Only the cursor is written: the cache is not rewritten on a hit.
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ driveBootstrapCursor: new Date('2024-03-01T00:00:00Z') });
    expect(updates()[0]).not.toHaveProperty('driveBootstrapFiles');
  });

  it('resumes from the day after the cursor, and finishes on the last day', async () => {
    m.loadEntity.mockResolvedValue({ ...CTX, driveBootstrapCursor: '2024-03-01' });
    m.prisma.account.findUnique.mockResolvedValue({ driveBootstrapFiles: column(V2_COLUMN) });

    const result = await runBackfill(ARGS);

    expect(m.gatherFilesAuto).not.toHaveBeenCalled();
    const [batchFiles, opts] = m.processBatch.mock.calls[0]!;
    expect((batchFiles as TraversedFile[]).map((f) => f.id)).toEqual(['file-2']);
    expect(opts.editedAt).toBe('2024-03-02');
    expect(result.bootstrapCompleted).toBe(true);
  });

  it('still resumes from a legacy-format cache written before the change', async () => {
    m.prisma.account.findUnique.mockResolvedValue({ driveBootstrapFiles: column(LEGACY_COLUMN) });

    const result = await runBackfill(ARGS);

    expect(m.gatherFilesAuto).not.toHaveBeenCalled();
    expect(logged()).toContain('  ✓ Files cache HIT  (3 files, 2 active days)');
    const [batchFiles] = m.processBatch.mock.calls[0]!;
    expect((batchFiles as TraversedFile[]).map((f) => f.id)).toEqual(DAY_1);
    expect(result.scansProcessed).toBe(1);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).not.toHaveProperty('driveBootstrapFiles');
  });
});

describe('bootstrap path — cache miss', () => {
  it('no cache: discovers, writes the current format, then scans', async () => {
    m.prisma.account.findUnique.mockResolvedValue({ driveBootstrapFiles: null });

    await runBackfill(ARGS);

    expect(m.gatherFilesAuto).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('  ✓ Files cache WRITTEN  (3 files)');
    // First write: the cache, version 2 — each file once, days list ids.
    const written = updates()[0]!.driveBootstrapFiles as Record<string, unknown>;
    expect(written).toMatchObject({
      version: 2,
      activeDates: [
        { date: '2024-03-01', fileIds: DAY_1 },
        { date: '2024-03-02', fileIds: ['file-2'] },
      ],
    });
    expect(written.files).toEqual(FILES);
    // Second write: the cursor.
    expect(updates()[1]).toHaveProperty('driveBootstrapCursor');
    const [batchFiles] = m.processBatch.mock.calls[0]!;
    expect((batchFiles as TraversedFile[]).map((f) => f.id)).toEqual(DAY_1);
  });

  it('an unusable cache is a miss: says so, re-discovers and overwrites it', async () => {
    // A day that lists an id the file list does not have.
    const corrupt = {
      version: 2,
      files: FILES,
      activeDates: [{ date: '2024-03-01', fileIds: ['file-1', 'file-404'] }],
    };
    m.prisma.account.findUnique.mockResolvedValue({ driveBootstrapFiles: column(corrupt) });

    await runBackfill(ARGS);

    expect(logged().some((l) => l.includes('Files cache unusable'))).toBe(true);
    expect(logged().some((l) => l.includes('Files cache HIT'))).toBe(false);
    expect(m.gatherFilesAuto).toHaveBeenCalledTimes(1);
    expect(updates()[0]!.driveBootstrapFiles).toMatchObject({ version: 2 });
  });

  it('a dry run reads the cache but never writes one', async () => {
    m.prisma.account.findUnique.mockResolvedValue({ driveBootstrapFiles: null });

    await runBackfill({ ...ARGS, dryrun: true });

    expect(m.gatherFilesAuto).toHaveBeenCalledTimes(1);
    expect(m.prisma.account.update).not.toHaveBeenCalled();
    expect(logged().some((l) => l.includes('Files cache WRITTEN'))).toBe(false);
  });
});
