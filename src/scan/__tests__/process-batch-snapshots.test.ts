import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts validates env at import; the scan core pulls it in transitively.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { snapshotCreate, extractText, interpretFile, warn, captured } = vi.hoisted(() => ({
  snapshotCreate: vi.fn(),
  extractText: vi.fn(),
  interpretFile: vi.fn(),
  warn: vi.fn(),
  captured: [] as string[],
}));

vi.mock('../../prisma', () => ({
  prisma: {
    driveFileSnapshot: { create: snapshotCreate },
    driveRestrictedFile: {
      findMany: vi.fn().mockResolvedValue([]),
      // Already on the worklist: a first sighting would push an observation
      // and pull distillation into a test about the index.
      findUnique: vi.fn().mockResolvedValue({ id: 'worklist-row' }),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    campaign: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    campaignPiece: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));
vi.mock('../../drive/extract', () => ({ extractText }));
vi.mock('../../drive/interpret', () => ({ interpretFile }));
// The human scan log: collected here instead of written to stdout.
vi.mock('../output', async (importActual) => ({
  ...(await importActual<typeof import('../output')>()),
  log: (line = '') => void captured.push(line),
}));

import { processBatch, type ProcessBatchOptions } from '../process-batch';
import type { EntityCtx } from '../batch-types';
import type { EntityAttribution } from '../../drive/structure';
import type { TraversedFile } from '../../drive/types';

function file(id: string, parent: string): TraversedFile {
  return {
    id,
    name: `${id}.pdf`,
    mimeType: 'application/pdf',
    parents: [parent],
    path: `Acme / ${parent} / ${id}.pdf`,
    modifiedTime: '2026-09-20T10:00:00.000Z',
    modifiedByEmail: 'editor@example.com',
    createdTime: null,
    size: 2048,
    isFolder: false,
  };
}

const ACCOUNT_ZONE: EntityAttribution = {
  ownerType: 'account',
  campaignFolderId: null,
  campaignName: null,
  matchedCampaignId: null,
  campaignStatus: null,
  pieceId: null,
  pieceName: null,
  pieceFolderId: null,
};

const CAMPAIGN_ZONE: EntityAttribution = {
  ownerType: 'campaign',
  campaignFolderId: 'folder-q3',
  campaignName: 'Q3 Launch',
  matchedCampaignId: 'camp-q3',
  campaignStatus: 'existing',
  pieceId: null,
  pieceName: null,
  pieceFolderId: null,
};

function ctx(over: Partial<EntityCtx> = {}): EntityCtx {
  return {
    type: 'account',
    id: 'acct-1',
    name: 'Acme',
    folderId: 'folder-root',
    accountId: 'acct-1',
    accountFolderId: null,
    accountState: {},
    accountName: 'Acme',
    campaignName: null,
    campaignState: null,
    statusMarkdown: null,
    statusSensitiveMarkdown: null,
    ...over,
  } as EntityCtx;
}

const RUN = '8d0c4a52-3f6e-4b7a-9c1d-2e5f60718293';

function opts(over: Partial<ProcessBatchOptions> = {}): ProcessBatchOptions {
  return {
    ctx: ctx(),
    attributor: (parent) => (parent === 'folder-q3' ? CAMPAIGN_ZONE : ACCOUNT_ZONE),
    nameDirectory: null,
    folderPathById: null,
    piecesById: null,
    familyByCampaignId: null,
    application: 'propose',
    editedAt: '2026-09-24',
    concurrency: 1,
    driveSyncRunId: RUN,
    ...over,
  };
}

// One file per outcome kind, in index order: ok, skip, restricted, error.
const BATCH = [
  file('ok', 'folder-q3'),
  file('empty', 'folder-misc'),
  file('locked', 'folder-q3'),
  file('broken', 'folder-misc'),
];

beforeEach(() => {
  vi.clearAllMocks();
  captured.length = 0;
  snapshotCreate.mockResolvedValue({});
  extractText.mockImplementation(async (f: TraversedFile) => {
    if (f.id === 'ok')
      return { kind: 'ok', text: 'brief text', contentHash: 'hash-ok', extractor: 'text' };
    if (f.id === 'empty') return { kind: 'skip', reason: 'empty' };
    if (f.id === 'locked') throw Object.assign(new Error('forbidden'), { code: 403 });
    throw new Error('parser exploded');
  });
  interpretFile.mockResolvedValue({
    account: [],
    campaign: [],
    deckType: 'other',
    truncated: false,
    driver: 'mock',
  });
});

const rows = () => snapshotCreate.mock.calls.map((c) => c[0].data);

describe('processBatch writes the Drive name index', () => {
  it('writes one snapshot per scanned file in propose mode, in file order', async () => {
    const outcome = await processBatch(BATCH, opts());

    expect(rows().map((r) => r.fileId)).toEqual(['ok', 'empty', 'locked', 'broken']);
    expect(rows()[0]).toMatchObject({
      accountId: 'acct-1',
      campaignId: 'camp-q3',
      name: 'ok.pdf',
      path: 'Acme / folder-q3 / ok.pdf',
      wasExtracted: true,
      contentHash: 'hash-ok',
      skipReason: null,
    });
    expect(rows()[1]).toMatchObject({ wasExtracted: false, skipReason: 'empty', campaignId: null });
    expect(rows()[2]).toMatchObject({
      wasExtracted: false,
      skipReason: 'restricted',
      campaignId: 'camp-q3',
    });
    expect(rows()[3]).toMatchObject({ wasExtracted: false, skipReason: 'extract_error' });
    expect(outcome.snapshotWriteFailures).toBe(0);
  });

  it('counts a file as extracted only once its interpret call returned (v2 was_extracted)', async () => {
    interpretFile.mockRejectedValueOnce(new Error('rate limited'));

    await processBatch([file('ok', 'folder-q3')], opts());

    // The text WAS extracted, but the file never got interpreted: unlike v1,
    // the row must not claim it was.
    expect(rows()[0]).toMatchObject({
      wasExtracted: false,
      skipReason: 'extract_error',
      contentHash: null,
    });
  });

  it('records the queue run in drive_sync_run_id and leaves sync_run_id NULL', async () => {
    await processBatch(BATCH, opts());

    // sync_run_id references the v1 sync_runs table, not the drive_sync_runs queue.
    expect(rows().map((r) => r.syncRunId)).toEqual([null, null, null, null]);
    expect(rows().map((r) => r.driveSyncRunId)).toEqual([RUN, RUN, RUN, RUN]);
  });

  it('records no run when the caller has none (a CLI backfill)', async () => {
    await processBatch(BATCH, opts({ driveSyncRunId: null }));
    expect(rows().map((r) => r.driveSyncRunId)).toEqual([null, null, null, null]);
  });

  it('writes them in apply mode too — the bootstrap day-walk had the same gap', async () => {
    await processBatch(BATCH, opts({ application: 'apply' }));
    expect(snapshotCreate).toHaveBeenCalledTimes(4);
  });

  it('writes nothing in dryrun', async () => {
    const outcome = await processBatch(BATCH, opts({ application: 'dryrun' }));
    expect(snapshotCreate).not.toHaveBeenCalled();
    expect(outcome.snapshotWriteFailures).toBe(0);
  });

  it('keeps the same rows under a parallel pool', async () => {
    await processBatch(BATCH, opts({ concurrency: 4 }));
    expect(rows().map((r) => r.fileId)).toEqual(['ok', 'empty', 'locked', 'broken']);
  });

  it('stamps the scanned campaign on a campaign-scoped scan', async () => {
    await processBatch(
      [file('ok', 'folder-anything')],
      opts({
        ctx: ctx({ type: 'campaign', id: 'camp-scanned', campaignName: 'Scanned' }),
        attributor: null,
      }),
    );
    expect(rows()[0]).toMatchObject({
      campaignId: 'camp-scanned',
      syncRunId: null,
      driveSyncRunId: RUN,
    });
  });
});

describe('a failed index row', () => {
  const dbDown = Object.assign(new Error('connection reset by peer for editor@example.com'), {
    code: 'P1001',
  });

  it('is counted and reported, and the batch still resolves with later files indexed', async () => {
    snapshotCreate.mockRejectedValueOnce(dbDown);

    const outcome = await processBatch(BATCH, opts());

    expect(outcome.filesExtracted).toBe(1);
    expect(outcome.snapshotWriteFailures).toBe(1);
    expect(snapshotCreate).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { fileId: 'ok', accountId: 'acct-1', source: 'scan', code: 'P1001', constraint: null },
      '[drive.snapshot] write failed',
    );
  });

  it('shows up in the scan log by code only, never by the error message', async () => {
    snapshotCreate.mockRejectedValueOnce(dbDown);

    await processBatch(BATCH, opts());

    const text = captured.join('\n');
    expect(text).toContain('✗ snapshot write failed for ok.pdf: P1001');
    expect(text).toContain('1 drive_file_snapshots write(s) failed');
    expect(text).not.toContain('connection reset');
    expect(text).not.toContain('editor@example.com');
  });

  it('counts every failed row, not just the first', async () => {
    snapshotCreate.mockRejectedValue(dbDown);
    const outcome = await processBatch(BATCH, opts({ concurrency: 4 }));
    expect(outcome.snapshotWriteFailures).toBe(4);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
