/**
 * processBatch hands its queue run id to proposeTarget, so the review
 * proposals of a forward run carry drive_sync_run_id just like its snapshot
 * rows. Distillation and the proposal writer are mocked: this pins the scan
 * core's wiring. The rows themselves are checked in propose.test.ts and, with
 * the real schema, in forward/__tests__/snapshot-index.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts validates env at import; the scan core pulls it in transitively.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { extractText, interpretFile, runDistillation, proposeTarget } = vi.hoisted(() => ({
  extractText: vi.fn(),
  interpretFile: vi.fn(),
  runDistillation: vi.fn(),
  proposeTarget: vi.fn(),
}));

vi.mock('../../prisma', () => ({
  prisma: {
    driveFileSnapshot: { create: vi.fn().mockResolvedValue({}) },
    driveRestrictedFile: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
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
vi.mock('../../drive/extract', () => ({ extractText }));
vi.mock('../../drive/interpret', () => ({ interpretFile }));
vi.mock('../persist', () => ({ runDistillation, persistTarget: vi.fn() }));
vi.mock('../propose', () => ({
  proposeTarget,
  loadPendingNoteTexts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../output', async (importActual) => ({
  ...(await importActual<typeof import('../output')>()),
  log: vi.fn(),
}));

import { processBatch, type ProcessBatchOptions } from '../process-batch';
import type { EntityCtx } from '../batch-types';
import type { EntityAttribution } from '../../drive/structure';
import type { TraversedFile } from '../../drive/types';

const RUN = '8d0c4a52-3f6e-4b7a-9c1d-2e5f60718293';

const FILE: TraversedFile = {
  id: 'f-brief',
  name: 'Brief.pdf',
  mimeType: 'application/pdf',
  parents: ['folder-q3'],
  path: 'Acme / Q3 Launch / Brief.pdf',
  modifiedTime: '2026-09-20T10:00:00.000Z',
  modifiedByEmail: 'editor@example.com',
  createdTime: null,
  size: 2048,
  isFolder: false,
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
    attributor: () => CAMPAIGN_ZONE,
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

beforeEach(() => {
  vi.clearAllMocks();
  extractText.mockResolvedValue({
    kind: 'ok',
    text: 'brief text',
    contentHash: 'hash-ok',
    extractor: 'text',
  });
  // One campaign observation: it makes the campaign a stage-3 target.
  interpretFile.mockResolvedValue({
    account: [],
    campaign: [
      { text: 'Launch moved to October', reasoning: 'Stated in the brief', confidence: 0.9 },
    ],
    deckType: 'other',
    truncated: false,
    driver: 'mock',
  });
  runDistillation.mockResolvedValue({
    field_changes: [],
    notes: [{ text: 'Launch moved to October', source_file_ids: ['f-brief'] }],
    driver: 'mock',
  });
  proposeTarget.mockResolvedValue({ fieldProposals: 0, noteItems: 1, duplicatesSkipped: 0 });
});

describe('processBatch proposals carry the run', () => {
  it('hands the queue run id to proposeTarget when it proposes for review', async () => {
    const outcome = await processBatch([FILE], opts());

    expect(outcome.stage3Failures).toBe(0);
    expect(proposeTarget).toHaveBeenCalledTimes(1);
    expect(proposeTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'campaign',
        entityId: 'camp-q3',
        driveSyncRunId: RUN,
      }),
    );
  });

  it('hands null when the caller has no run row (a CLI backfill)', async () => {
    await processBatch([FILE], opts({ driveSyncRunId: null }));

    expect(proposeTarget).toHaveBeenCalledWith(expect.objectContaining({ driveSyncRunId: null }));
  });
});
