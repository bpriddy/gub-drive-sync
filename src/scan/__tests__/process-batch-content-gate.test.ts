import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts validates env at import; the scan core pulls it in transitively.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { snapshotCreate, extractText, interpretFile, queryRaw, info, warn, captured } = vi.hoisted(
  () => ({
    snapshotCreate: vi.fn(),
    extractText: vi.fn(),
    interpretFile: vi.fn(),
    queryRaw: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    captured: [] as string[],
  }),
);

vi.mock('../../prisma', () => ({
  prisma: {
    driveFileSnapshot: { create: snapshotCreate },
    $queryRaw: queryRaw,
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
  logger: { debug: vi.fn(), info, warn, error: vi.fn() },
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
import { binaryContentHash, contentZone, textContentHash } from '../content-gate';

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
  queryRaw.mockResolvedValue([]);
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

describe('the stored content hash', () => {
  it('flag off: the extractor md5, as before', async () => {
    await processBatch([doc('a')], opts());
    expect(rows()[0]).toMatchObject({ wasExtracted: true, contentHash: 'md5-of-text' });
  });

  it('flag on: the versioned hash, v2 for a Google-native file', async () => {
    setFlag('on');
    await processBatch([doc('a')], opts());
    expect(rows()[0].contentHash).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  it('flag on: the bin hash for a downloaded file with an md5', async () => {
    setFlag('on');
    await processBatch(
      [doc('p', { mimeType: 'application/pdf', name: 'p.pdf', md5Checksum: 'abc' })],
      opts(),
    );
    expect(rows()[0].contentHash).toMatch(/^bin:[0-9a-f]{64}$/);
  });
});

describe('the unchanged-content gate', () => {
  const ZONE = contentZone(ACCOUNT_ZONE);
  const GATE = { unchangedGate: { notAfter: new Date('2026-10-20T00:00:00Z') } };
  const MAX = config.GEMINI_MAX_INPUT_CHARS;
  const prior = (fileId: string, contentHash: string) => ({ fileId, contentHash });
  const pdf = (id: string, over: Partial<TraversedFile> = {}) =>
    doc(id, {
      mimeType: 'application/pdf',
      name: `${id}.pdf`,
      path: `Acme / folder-misc / ${id}.pdf`,
      size: 2048,
      ...over,
    });

  beforeEach(() => setFlag('on'));

  it('unchanged: interpret skipped, the snapshot row still written', async () => {
    queryRaw.mockResolvedValue([prior('a', textContentHash('brief text', doc('a'), ZONE))]);

    const outcome = await processBatch([doc('a')], opts(GATE));

    expect(extractText).toHaveBeenCalledTimes(1); // a native file is read to hash it
    expect(interpretFile).not.toHaveBeenCalled();
    expect(rows()).toEqual([
      expect.objectContaining({
        fileId: 'a',
        wasExtracted: false,
        skipReason: 'content_unchanged',
        contentHash: null,
      }),
    ]);
    expect(outcome).toMatchObject({ filesUnchanged: 1, filesExtracted: 0, filesSkipped: 0 });
  });

  it('rename: the name is in the hash, so the file is interpreted', async () => {
    queryRaw.mockResolvedValue([prior('a', textContentHash('brief text', doc('a'), ZONE))]);

    await processBatch(
      [doc('a', { name: 'a brief v2', path: 'Acme / folder-misc / a brief v2' })],
      opts(GATE),
    );

    expect(interpretFile).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({ wasExtracted: true, skipReason: null });
  });

  it('an edit past the prompt cut is not prompt-visible: skipped', async () => {
    const head = 'x'.repeat(MAX);
    queryRaw.mockResolvedValue([
      prior('big', textContentHash(`${head} old tail`, doc('big'), ZONE)),
    ]);
    extractText.mockResolvedValue({
      kind: 'ok',
      text: `${head} a new, longer tail`,
      contentHash: 'md5',
      extractor: 'gdoc',
    });

    await processBatch([doc('big')], opts(GATE));

    expect(interpretFile).not.toHaveBeenCalled();
    expect(rows()[0]).toMatchObject({ skipReason: 'content_unchanged' });
  });

  it('an edit inside the prompt-visible text: interpreted', async () => {
    queryRaw.mockResolvedValue([prior('a', textContentHash('old brief', doc('a'), ZONE))]);
    await processBatch([doc('a')], opts(GATE));
    expect(interpretFile).toHaveBeenCalledTimes(1);
  });

  it('binary with an equal md5: no download at all', async () => {
    const file = pdf('p', { md5Checksum: 'abc' });
    queryRaw.mockResolvedValue([prior('p', binaryContentHash(file, ZONE)!)]);

    const outcome = await processBatch([file], opts(GATE));

    expect(extractText).not.toHaveBeenCalled();
    expect(interpretFile).not.toHaveBeenCalled();
    expect(rows()[0]).toMatchObject({ wasExtracted: false, skipReason: 'content_unchanged' });
    expect(outcome).toMatchObject({ filesUnchanged: 1, filesUnchangedBeforeDownload: 1 });
  });

  it('binary with a new md5: downloaded, interpreted, the new bin hash stored', async () => {
    const before = pdf('p', { md5Checksum: 'abc' });
    const after = pdf('p', { md5Checksum: 'abd' });
    queryRaw.mockResolvedValue([prior('p', binaryContentHash(before, ZONE)!)]);

    await processBatch([after], opts(GATE));

    expect(extractText).toHaveBeenCalledTimes(1);
    expect(interpretFile).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({
      wasExtracted: true,
      contentHash: binaryContentHash(after, ZONE),
    });
  });

  it('reads the prior hashes of the whole batch in one query', async () => {
    await processBatch([doc('a'), doc('b'), pdf('c', { md5Checksum: 'm' })], opts(GATE));
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(interpretFile).toHaveBeenCalledTimes(3); // nothing on file: all interpreted
  });

  it('logs one structured line per gated batch with the counters', async () => {
    queryRaw.mockResolvedValue([prior('a', textContentHash('brief text', doc('a'), ZONE))]);
    await processBatch([doc('a'), doc('b', { trashed: true })], opts(GATE));
    expect(info).toHaveBeenCalledWith(
      {
        accountId: 'acct-1',
        filesAttempted: 2,
        filesUnchanged: 1,
        filesUnchangedBeforeDownload: 0,
        filesTrashed: 1,
        priorHashes: 1,
      },
      '[scan.content-gate] batch',
    );
  });

  it('a failed lookup fails open: every file is interpreted', async () => {
    queryRaw.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'P1001' }));

    await processBatch([doc('a')], opts(GATE));

    expect(interpretFile).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { accountId: 'acct-1', code: 'P1001' },
      '[scan.content-gate] hash lookup failed — interpreting every file',
    );
  });

  it('no gate passed (backfill, bootstrap): no lookup, every file interpreted', async () => {
    await processBatch([doc('a')], opts());
    expect(queryRaw).not.toHaveBeenCalled();
    expect(interpretFile).toHaveBeenCalledTimes(1);
  });

  it("flag off: today's behaviour even with a gate and a matching row", async () => {
    setFlag('off');
    queryRaw.mockResolvedValue([prior('a', textContentHash('brief text', doc('a'), ZONE))]);

    const outcome = await processBatch([doc('a')], opts(GATE));

    expect(queryRaw).not.toHaveBeenCalled();
    expect(interpretFile).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({ wasExtracted: true, contentHash: 'md5-of-text' });
    expect(outcome).toMatchObject({ filesUnchanged: 0, filesTrashed: 0, filesExtracted: 1 });
  });
});
