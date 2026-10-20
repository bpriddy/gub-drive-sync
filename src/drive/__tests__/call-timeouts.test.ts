/**
 * Each LLM call type carries its own configured deadline to the driver.
 * Distinct values per type so a crossed wire shows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ runPreset: vi.fn(), complete: vi.fn() }));

vi.mock('../../config', () => ({
  config: {
    GEMINI_MAX_INPUT_CHARS: 40_000,
    GEMINI_TIMEOUT_INTERPRET_MS: 111,
    GEMINI_TIMEOUT_DISTILL_MS: 222,
    GEMINI_TIMEOUT_CLASSIFY_MS: 333,
  },
}));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../prisma', () => ({ prisma: {} }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn() }));
vi.mock('../../ai', async (importActual) => ({
  ...(await importActual<typeof import('../../ai')>()),
  runPreset: m.runPreset,
  defaultLlm: { name: 'stub', complete: m.complete },
}));

import { interpretFile } from '../interpret';
import { runDistillation } from '../../scan/persist';
import { classifyFolders } from '../structure';

beforeEach(() => {
  m.runPreset.mockReset().mockResolvedValue({ text: '{}', driver: 'stub', model: 'x', prompt: '' });
  m.complete.mockReset().mockResolvedValue({ text: '{}', driver: 'stub', model: 'x' });
});

describe('per-call-type Gemini deadlines', () => {
  it('interpret uses GEMINI_TIMEOUT_INTERPRET_MS', async () => {
    await interpretFile({
      file: { id: 'f', name: 'f', mimeType: 'text/plain', path: 'A / f', isFolder: false } as never,
      text: 'body',
      accountName: 'A',
      accountCurrentState: {} as never,
      campaignName: null,
      campaignCurrentState: null,
      knownCampaigns: [],
    }).catch(() => undefined); // the stub's '{}' fails validation; only the call matters
    expect(m.runPreset).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'drive.file_extraction.v1', timeoutMs: 111 }),
    );
  });

  it('distill uses GEMINI_TIMEOUT_DISTILL_MS', async () => {
    await runDistillation('account', [], {} as never).catch(() => undefined);
    expect(m.runPreset).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'drive.distillation.v1', timeoutMs: 222 }),
    );
  });

  it('folder classify uses GEMINI_TIMEOUT_CLASSIFY_MS', async () => {
    await classifyFolders({
      accountId: 'a',
      accountName: 'A',
      rootFolderId: 'root',
      folders: [
        { id: 'f1', name: 'Folder', path: 'A / Folder', depth: 1, parentId: null } as never,
      ],
      existingCampaigns: [],
    }).catch(() => undefined);
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 333 }));
  });
});
