/**
 * runForward cursor gate: the account's forward cursor may advance only
 * when nothing recoverable was lost. I/O is mocked at the module boundary;
 * the driver's control flow is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';

const m = vi.hoisted(() => ({
  findAccount: vi.fn(),
  updateAccount: vi.fn(),
  getFileMetadata: vi.fn(),
  queryActivityWindow: vi.fn(),
  processBatch: vi.fn(),
  notifyReviewers: vi.fn(),
  gateCutoff: vi.fn(),
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
vi.mock('../../scan/content-gate', () => ({ gateCutoff: m.gateCutoff }));
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
vi.mock('../stats', () => ({ writeRunEditStats: vi.fn(async () => 0) }));

import { config } from '../../config';
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

function cleanOutcome(over: Record<string, number> = {}) {
  return { stage3Failures: 0, transientFileErrors: 0, filesErrored: 0, ...over };
}

const run = () => runForward({ accountId: 'acc-1', syncRunId: 'run-1' });
const cursorAdvanced = () =>
  m.updateAccount.mock.calls.some(
    ([arg]) => (arg as { data?: { driveForwardCursorAt?: unknown } }).data?.driveForwardCursorAt,
  );

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
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
  m.processBatch.mockResolvedValue(cleanOutcome());
  m.notifyReviewers.mockResolvedValue({});
  delete (config as { SKIP_UNCHANGED_CONTENT?: string }).SKIP_UNCHANGED_CONTENT;
});

describe('runForward cursor gate', () => {
  it('advances the cursor on a clean window', async () => {
    await run();
    expect(cursorAdvanced()).toBe(true);
  });

  it('holds the cursor when a distill failed (stage-3 failure)', async () => {
    m.processBatch.mockResolvedValue(cleanOutcome({ stage3Failures: 1 }));
    await expect(run()).rejects.toThrow(/1 stage-3 failure\(s\) — cursor NOT advanced/);
    expect(cursorAdvanced()).toBe(false);
  });

  it('holds the cursor when a worker lost a file to a transient error', async () => {
    m.processBatch.mockResolvedValue(cleanOutcome({ filesErrored: 1, transientFileErrors: 1 }));
    await expect(run()).rejects.toThrow(/1 transient file error\(s\) — cursor NOT advanced/);
    expect(cursorAdvanced()).toBe(false);
  });

  it('still advances past a permanent worker error (counted-and-dropped)', async () => {
    m.processBatch.mockResolvedValue(cleanOutcome({ filesErrored: 1 }));
    await run();
    expect(cursorAdvanced()).toBe(true);
  });

  it('fails before any LLM spend when metadata fails transiently', async () => {
    m.getFileMetadata.mockImplementation(async (id: string) => {
      if (id === 'f2') throw new ApiError({ message: 'backend error', status: 503 });
      return meta(id);
    });
    await expect(run()).rejects.toThrow(/1 transient metadata failure\(s\) — cursor NOT advanced/);
    expect(m.processBatch).not.toHaveBeenCalled();
    expect(cursorAdvanced()).toBe(false);
  });

  it('stops fetching at the first transient metadata failure', async () => {
    m.getFileMetadata.mockRejectedValue(new ApiError({ message: 'backend error', status: 503 }));
    await expect(run()).rejects.toThrow(/1 transient metadata failure\(s\)/);
    expect(m.getFileMetadata).toHaveBeenCalledTimes(1);
  });

  it('drops a file whose metadata fails permanently and advances as before', async () => {
    m.getFileMetadata.mockImplementation(async (id: string) => {
      if (id === 'f2') throw { code: 403, errors: [{ reason: 'forbidden' }], message: 'forbidden' };
      return meta(id);
    });
    await run();
    expect(m.processBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'f1' })],
      expect.anything(),
    );
    expect(cursorAdvanced()).toBe(true);
  });
});

describe('runForward unchanged-content gate', () => {
  const flagOn = () => {
    (config as { SKIP_UNCHANGED_CONTENT?: string }).SKIP_UNCHANGED_CONTENT = 'on';
  };
  const gateArg = () =>
    (m.processBatch.mock.calls[0]![1] as { unchangedGate?: unknown }).unchangedGate;

  it('flag off: no cutoff read, no gate', async () => {
    await run();
    expect(m.gateCutoff).not.toHaveBeenCalled();
    expect(gateArg()).toBeNull();
  });

  it('flag on: the gate compares with rows up to the last completed run', async () => {
    flagOn();
    const done = new Date('2026-10-18T06:00:00Z');
    m.gateCutoff.mockResolvedValue(done);
    await run();
    expect(m.gateCutoff).toHaveBeenCalledWith('acc-1');
    expect(gateArg()).toEqual({ notAfter: done });
  });

  it('flag on, no completed run yet: no gate, every file is interpreted', async () => {
    flagOn();
    m.gateCutoff.mockResolvedValue(null);
    await run();
    expect(gateArg()).toBeNull();
  });

  it('flag on, cutoff unreadable: fails open (no gate) and the window still commits', async () => {
    flagOn();
    m.gateCutoff.mockRejectedValue(new Error('connection reset'));
    await run();
    expect(gateArg()).toBeNull();
    expect(cursorAdvanced()).toBe(true);
  });
});
