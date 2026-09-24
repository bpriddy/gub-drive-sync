import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts validates env at import; the scan core pulls it in transitively.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { snapshotCreate, extractText, interpretFile } = vi.hoisted(() => ({
  snapshotCreate: vi.fn(),
  extractText: vi.fn(),
  interpretFile: vi.fn(),
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
vi.mock('../../drive/extract', () => ({ extractText }));
vi.mock('../../drive/interpret', () => ({ interpretFile }));

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
    path: `Chevy / ${parent} / ${id}.pdf`,
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

const BHAC_ZONE: EntityAttribution = {
  ownerType: 'campaign',
  campaignFolderId: 'folder-bhac',
  campaignName: 'BHAC',
  matchedCampaignId: 'camp-bhac',
  campaignStatus: 'existing',
  pieceId: null,
  pieceName: null,
  pieceFolderId: null,
};

function ctx(over: Partial<EntityCtx> = {}): EntityCtx {
  return {
    type: 'account',
    id: 'acct-1',
    name: 'Chevy',
    folderId: 'folder-root',
    accountId: 'acct-1',
    accountFolderId: null,
    accountState: {},
    accountName: 'Chevy',
    campaignName: null,
    campaignState: null,
    statusMarkdown: null,
    statusSensitiveMarkdown: null,
    ...over,
  } as EntityCtx;
}

function opts(over: Partial<ProcessBatchOptions> = {}): ProcessBatchOptions {
  return {
    ctx: ctx(),
    attributor: (parent) => (parent === 'folder-bhac' ? BHAC_ZONE : ACCOUNT_ZONE),
    nameDirectory: null,
    folderPathById: null,
    piecesById: null,
    familyByCampaignId: null,
    application: 'propose',
    editedAt: '2026-09-24',
    concurrency: 1,
    syncRunId: 'run-1',
    ...over,
  };
}

// One file per outcome kind, in index order: ok, skip, restricted, error.
const BATCH = [
  file('ok', 'folder-bhac'),
  file('empty', 'folder-misc'),
  file('locked', 'folder-bhac'),
  file('broken', 'folder-misc'),
];

beforeEach(() => {
  vi.clearAllMocks();
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
    await processBatch(BATCH, opts());

    expect(rows().map((r) => r.fileId)).toEqual(['ok', 'empty', 'locked', 'broken']);
    expect(rows()[0]).toMatchObject({
      syncRunId: 'run-1',
      accountId: 'acct-1',
      campaignId: 'camp-bhac',
      name: 'ok.pdf',
      path: 'Chevy / folder-bhac / ok.pdf',
      wasExtracted: true,
      contentHash: 'hash-ok',
      skipReason: null,
    });
    expect(rows()[1]).toMatchObject({ wasExtracted: false, skipReason: 'empty', campaignId: null });
    expect(rows()[2]).toMatchObject({
      wasExtracted: false,
      skipReason: 'restricted',
      campaignId: 'camp-bhac',
    });
    expect(rows()[3]).toMatchObject({ wasExtracted: false, skipReason: 'extract_error' });
  });

  it('writes them in apply mode too — the bootstrap day-walk had the same gap', async () => {
    await processBatch(BATCH, opts({ application: 'apply' }));
    expect(snapshotCreate).toHaveBeenCalledTimes(4);
  });

  it('writes nothing in dryrun', async () => {
    await processBatch(BATCH, opts({ application: 'dryrun' }));
    expect(snapshotCreate).not.toHaveBeenCalled();
  });

  it('keeps the same rows under a parallel pool', async () => {
    await processBatch(BATCH, opts({ concurrency: 4 }));
    expect(rows().map((r) => r.fileId)).toEqual(['ok', 'empty', 'locked', 'broken']);
  });

  it('survives a failed row: the batch resolves and later files are still indexed', async () => {
    snapshotCreate.mockRejectedValueOnce(new Error('connection reset'));
    const outcome = await processBatch(BATCH, opts());
    expect(outcome.filesExtracted).toBe(1);
    expect(snapshotCreate).toHaveBeenCalledTimes(4);
  });

  it('stamps the scanned campaign on a campaign-scoped scan', async () => {
    await processBatch(
      [file('ok', 'folder-anything')],
      opts({
        ctx: ctx({ type: 'campaign', id: 'camp-scanned', campaignName: 'Scanned' }),
        attributor: null,
        syncRunId: null,
      }),
    );
    expect(rows()[0]).toMatchObject({ campaignId: 'camp-scanned', syncRunId: null });
  });
});
