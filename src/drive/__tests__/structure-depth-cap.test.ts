/**
 * Folder classify prompt with and without the depth cap (#69). The model
 * call is mocked at the ai module boundary; the prompt it receives is real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  prompts: [] as string[],
  info: vi.fn(),
}));

vi.mock('../../config', () => ({ config: { GEMINI_TIMEOUT_CLASSIFY_MS: 1000 } }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: m.info, warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../client', () => ({
  listAllFoldersInDrive: vi.fn(),
  listSubfolders: vi.fn(),
  probeFolder: vi.fn(),
}));
vi.mock('../../ai', async (importActual) => ({
  ...(await importActual<typeof import('../../ai')>()),
  defaultLlm: {
    complete: vi.fn(async (req: { prompt: string }) => {
      m.prompts.push(req.prompt);
      return { text: '{"folders":[]}', driver: 'mock' };
    }),
  },
}));

import { classifyFolders } from '../structure';
import { ACCOUNT_NAME, ANCHORS, FOLDERS, ROOT_ID } from './fixtures/folder-tree';

async function promptFor(depthCap?: number): Promise<string> {
  m.prompts.length = 0;
  await classifyFolders({
    accountId: 'acc-1',
    accountName: ACCOUNT_NAME,
    rootFolderId: ROOT_ID,
    folders: FOLDERS,
    existingCampaigns: ANCHORS,
    ...(depthCap === undefined ? {} : { depthCap }),
  });
  expect(m.prompts).toHaveLength(1);
  return m.prompts[0]!;
}

/** The tree lines of a classify prompt, without the account root line. */
function treeLines(prompt: string): string[] {
  const tree = prompt.split('FOLDER TREE (folders only — files omitted):\n')[1]!.split('\n\n')[0]!;
  return tree.split('\n').slice(1);
}

const shownIds = (prompt: string) =>
  treeLines(prompt).map((line) => /\[id: ([^\]]+)\]/.exec(line)![1]!);

beforeEach(() => {
  m.info.mockClear();
});

describe('classify prompt depth cap', () => {
  it('without a cap, sends the prompt byte for byte as before the cap existed', async () => {
    // Captured from classifyFolders at 19cf8eb, before the cap existed.
    const golden = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'classify-prompt-off.golden.txt'),
      'utf8',
    );
    expect(await promptFor()).toBe(golden);
    expect(m.info).not.toHaveBeenCalledWith(
      expect.anything(),
      '[drive.structure] classify tree capped',
    );
  });

  it('keeps every anchor and its ancestors below the cap, and hides the rest', async () => {
    const prompt = await promptFor(4);
    const ids = shownIds(prompt);

    // Down to depth 4, plus the depth-7 anchor and its depth-5 and -6 ancestors.
    expect(ids).toEqual([
      'f-clients',
      'f-2025',
      'f-spring',
      'f-creative',
      'f-holiday',
      'f-decks',
      'f-archive',
      'f-oldpitch',
      'f-assets',
      'f-deepa',
      'f-deepb',
      'f-legacy',
      'f-brand',
      'f-logos',
    ]);
    for (const hidden of ['f-round1', 'f-exports', 'f-files', 'f-spare']) {
      expect(prompt).not.toContain(hidden);
    }
  });

  it('puts the hidden folders as a count on their nearest shown ancestor', async () => {
    const lines = treeLines(await promptFor(4));
    const line = (id: string) => lines.find((l) => l.includes(`[id: ${id}]`))!;

    expect(line('f-creative')).toBe('        Creative/  [id: f-creative]  (+2 subfolders)');
    expect(line('f-deepb')).toBe('            Deep B/  [id: f-deepb]  (+1 subfolder)');
    expect(line('f-legacy')).toBe('              Legacy/  [id: f-legacy]  (+1 subfolder)');
    expect(line('f-decks')).toBe('        Decks/  [id: f-decks]');

    const counted = lines
      .map((l) => /\(\+(\d+) subfolders?\)$/.exec(l))
      .reduce((sum, match) => sum + (match ? Number(match[1]) : 0), 0);
    expect(lines.length + counted).toBe(FOLDERS.length);
  });

  it('logs the capped size and still maps every folder', async () => {
    m.prompts.length = 0;
    const map = await classifyFolders({
      accountId: 'acc-1',
      accountName: ACCOUNT_NAME,
      rootFolderId: ROOT_ID,
      folders: FOLDERS,
      existingCampaigns: ANCHORS,
      depthCap: 4,
    });

    expect(map.allFolders).toHaveLength(FOLDERS.length);
    expect(map.folderCount).toBe(FOLDERS.length);
    expect(m.info).toHaveBeenCalledWith(
      {
        accountId: 'acc-1',
        depthCap: 4,
        shownFolders: 14,
        hiddenFolders: 4,
        promptChars: m.prompts[0]!.length,
      },
      '[drive.structure] classify tree capped',
    );
  });
});
