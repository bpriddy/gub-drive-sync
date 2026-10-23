/**
 * processBatch failure accounting — the counters the drivers' cursor gates
 * read. Everything with I/O is mocked at the module boundary; the batch
 * machinery itself (worker pool, routing, stage-3 walk) is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';

const m = vi.hoisted(() => ({
  extractText: vi.fn(),
  interpretFile: vi.fn(),
  interpretAssetFolder: vi.fn(),
  runDistillation: vi.fn(),
  persistTarget: vi.fn(),
  proposeTarget: vi.fn(),
  loadPendingNoteTexts: vi.fn(),
  llmComplete: vi.fn(),
  restrictedFindUnique: vi.fn(),
  restrictedCreate: vi.fn(),
  restrictedUpdate: vi.fn(),
  logLines: [] as string[],
}));

vi.mock('../../config', () => ({ config: { SYNTH_CONCURRENCY: 2 } }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../prisma', () => ({
  prisma: {
    driveRestrictedFile: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(),
      findUnique: m.restrictedFindUnique,
      create: m.restrictedCreate,
      update: m.restrictedUpdate,
    },
    campaign: { findMany: vi.fn(async () => []) },
    campaignPiece: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('../../drive/extract', () => ({ extractText: m.extractText }));
vi.mock('../../drive/interpret', () => ({ interpretFile: m.interpretFile }));
vi.mock('../../drive/asset-folder', () => ({ interpretAssetFolder: m.interpretAssetFolder }));
vi.mock('../../drive/idea-scan', () => ({
  createIdeaScanContext: vi.fn(),
  extractIdeaCandidates: vi.fn(),
  mergeIdeaCandidates: vi.fn(),
}));
vi.mock('../../ai', () => ({
  defaultLlm: { complete: m.llmComplete },
  DEFAULT_GEMINI_MODEL: 'gemini-test',
}));
vi.mock('../persist', () => ({
  runDistillation: m.runDistillation,
  persistTarget: m.persistTarget,
}));
vi.mock('../propose', () => ({
  loadPendingNoteTexts: m.loadPendingNoteTexts,
  proposeTarget: m.proposeTarget,
}));
vi.mock('../output', () => ({
  log: (line = '') => m.logLines.push(line),
  rule: (t: string) => t,
  fmtMs: (n: number) => `${n}ms`,
  fmtBytes: (n: number) => `${n}B`,
}));

import { processBatch, type ProcessBatchOptions } from '../process-batch';
import type { EntityCtx } from '../batch-types';
import type { TraversedFile } from '../../drive/types';

const ACCOUNT_STATE = {} as EntityCtx['accountState'];

const ctx: EntityCtx = {
  type: 'account',
  id: 'acc-1',
  name: 'Account One',
  folderId: 'root-1',
  accountId: 'acc-1',
  accountFolderId: null, // no ideas tier
  accountState: ACCOUNT_STATE,
  accountName: 'Account One',
  campaignName: null,
  campaignState: null,
  statusMarkdown: null,
  statusSensitiveMarkdown: null,
  driveBootstrapCursor: null,
  driveStructureClassification: null,
  driveBootstrapFiles: null,
  reviewerEmail: null,
  reviewerStaffId: null,
} as EntityCtx;

function file(id: string): TraversedFile {
  return {
    id,
    name: `${id}.gdoc`,
    mimeType: 'application/vnd.google-apps.document',
    parents: ['root-1'],
    path: `Account One / ${id}.gdoc`,
    modifiedTime: '2026-10-19T10:00:00Z',
    modifiedByEmail: null,
    createdTime: null,
    size: null,
    isFolder: false,
  };
}

function opts(application: ProcessBatchOptions['application']): ProcessBatchOptions {
  return {
    ctx,
    attributor: null,
    nameDirectory: null,
    folderPathById: null,
    piecesById: null,
    familyByCampaignId: null,
    application,
    editedAt: '2026-10-20',
    concurrency: 2,
  };
}

const OBS = { text: 'The account renewed its contract.', reasoning: 'stated', confidence: 0.9 };

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === 'function') fn.mockReset();
  m.logLines.length = 0;
  m.extractText.mockResolvedValue({
    kind: 'ok',
    text: 'body',
    extractor: 'gdoc',
    contentHash: 'h',
  });
  m.interpretFile.mockResolvedValue({
    account: [OBS],
    campaign: [],
    deckType: 'other',
    driver: 'stub',
  });
  m.loadPendingNoteTexts.mockResolvedValue([]);
  m.runDistillation.mockResolvedValue({ field_changes: [], notes: [], driver: 'stub' });
  m.llmComplete.mockResolvedValue({ text: '', driver: 'stub', model: 'gemini-test' });
});

describe('processBatch — a failed distill is a stage-3 failure', () => {
  it('propose path: counts it and proposes nothing for the target', async () => {
    m.runDistillation.mockRejectedValue(new ApiError({ message: 'overloaded', status: 503 }));
    const outcome = await processBatch([file('f1')], opts('propose'));
    expect(outcome.stage3Failures).toBe(1);
    expect(m.proposeTarget).not.toHaveBeenCalled();
    expect(m.logLines.some((l) => l.includes('distill failed:'))).toBe(true);
  });

  it('apply path: counts it and neither synthesizes nor persists the target', async () => {
    m.runDistillation.mockRejectedValue(new Error('distill response invalid'));
    const outcome = await processBatch([file('f1')], opts('apply'));
    expect(outcome.stage3Failures).toBe(1);
    expect(m.llmComplete).not.toHaveBeenCalled();
    expect(m.persistTarget).not.toHaveBeenCalled();
  });

  it('a clean distill still proposes, with no failures counted', async () => {
    const outcome = await processBatch([file('f1')], opts('propose'));
    expect(outcome.stage3Failures).toBe(0);
    expect(m.proposeTarget).toHaveBeenCalledTimes(1);
  });
});

describe('processBatch — worker errors by failure class', () => {
  it('counts a transient worker error toward transientFileErrors', async () => {
    m.interpretFile
      .mockRejectedValueOnce(new ApiError({ message: 'rate limited', status: 429 }))
      .mockResolvedValue({ account: [OBS], campaign: [], deckType: 'other', driver: 'stub' });
    const outcome = await processBatch([file('f1'), file('f2')], opts('propose'));
    expect(outcome.filesErrored).toBe(1);
    expect(outcome.transientFileErrors).toBe(1);
  });

  it('keeps a permanent worker error counted-and-dropped only', async () => {
    m.extractText.mockRejectedValueOnce(new Error('Invalid PDF structure'));
    const outcome = await processBatch([file('f1'), file('f2')], opts('propose'));
    expect(outcome.filesErrored).toBe(1);
    expect(outcome.transientFileErrors).toBe(0);
  });
});

describe('processBatch — restricted-worklist write failures', () => {
  const PERMISSION_403 = { code: 403, errors: [{ reason: 'forbidden' }], message: 'forbidden' };
  const DB_DOWN = { code: 'P1001', message: "Can't reach database server" };

  it('a failed first sighting loses its observation — transient, so the window re-runs', async () => {
    m.extractText.mockRejectedValue(PERMISSION_403);
    m.restrictedFindUnique.mockResolvedValue(null);
    m.restrictedCreate.mockRejectedValue(DB_DOWN);
    const outcome = await processBatch([file('f1')], opts('propose'));
    expect(outcome.filesErrored).toBe(1);
    expect(outcome.transientFileErrors).toBe(1);
  });

  it('a failed lastProbedAt bump on a known row loses nothing — never holds the cursor', async () => {
    m.extractText.mockRejectedValue(PERMISSION_403);
    m.restrictedFindUnique.mockResolvedValue({ id: 'r1' });
    m.restrictedUpdate.mockRejectedValue(DB_DOWN);
    const outcome = await processBatch([file('f1')], opts('propose'));
    expect(outcome.filesErrored).toBe(1);
    expect(outcome.transientFileErrors).toBe(0);
  });
});
