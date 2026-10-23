import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts validates env at import; the scan core pulls it in transitively.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { snapshotCreate, extractText, interpretFile, captured } = vi.hoisted(() => ({
  snapshotCreate: vi.fn(),
  extractText: vi.fn(),
  interpretFile: vi.fn(),
  captured: [] as string[],
}));

vi.mock('../../prisma', () => ({
  prisma: {
    driveFileSnapshot: { create: snapshotCreate },
    driveRestrictedFile: {
      findMany: vi.fn().mockResolvedValue([]),
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
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../drive/extract', async (importActual) => ({
  ...(await importActual<typeof import('../../drive/extract')>()),
  extractText,
}));
vi.mock('../../drive/interpret', async (importActual) => ({
  ...(await importActual<typeof import('../../drive/interpret')>()),
  interpretFile,
}));
vi.mock('../output', async (importActual) => ({
  ...(await importActual<typeof import('../output')>()),
  log: (line = '') => void captured.push(line),
}));

import { config } from '../../config';
import { processBatch, type ProcessBatchOptions } from '../process-batch';
import type { EntityCtx } from '../batch-types';
import type { EntityAttribution } from '../../drive/structure';
import type { TraversedFile } from '../../drive/types';

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

function doc(id: string, over: Partial<TraversedFile> = {}): TraversedFile {
  return {
    id,
    name: `${id} brief`,
    mimeType: 'application/vnd.google-apps.document',
    parents: ['folder-misc'],
    path: `Acme / folder-misc / ${id} brief`,
    modifiedTime: '2026-09-20T10:00:00.000Z',
    modifiedByEmail: 'editor@example.com',
    createdTime: null,
    size: null,
    isFolder: false,
    ...over,
  };
}

function opts(over: Partial<ProcessBatchOptions> = {}): ProcessBatchOptions {
  return {
    ctx: {
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
    } as EntityCtx,
    attributor: () => ACCOUNT_ZONE,
    nameDirectory: null,
    folderPathById: null,
    piecesById: null,
    familyByCampaignId: null,
    application: 'propose',
    editedAt: '2026-09-24',
    concurrency: 1,
    ...over,
  };
}

const setFlag = (v: 'off' | 'on') => {
  (config as { SKIP_UNCHANGED_CONTENT: 'off' | 'on' }).SKIP_UNCHANGED_CONTENT = v;
};
const rows = () => snapshotCreate.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  captured.length = 0;
  snapshotCreate.mockResolvedValue({});
  extractText.mockResolvedValue({
    kind: 'ok',
    text: 'brief text',
    contentHash: 'md5-of-text',
    extractor: 'gdoc',
  });
  interpretFile.mockResolvedValue({
    account: [],
    campaign: [],
    deckType: 'other',
    truncated: false,
    driver: 'mock',
  });
});

afterEach(() => setFlag('off'));

describe('trashed files', () => {
  it('flag on: a trashed file is skipped before any read, with skip_reason trashed', async () => {
    setFlag('on');
    await processBatch([doc('binned', { trashed: true })], opts());

    expect(extractText).not.toHaveBeenCalled();
    expect(interpretFile).not.toHaveBeenCalled();
    expect(rows()).toEqual([
      expect.objectContaining({ fileId: 'binned', wasExtracted: false, skipReason: 'trashed' }),
    ]);
  });

  it('flag off: a trashed file is read and interpreted as before', async () => {
    await processBatch([doc('binned', { trashed: true })], opts());

    expect(extractText).toHaveBeenCalledTimes(1);
    expect(interpretFile).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({ wasExtracted: true, skipReason: null });
  });
});
