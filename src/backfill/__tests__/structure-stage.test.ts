/**
 * resolveAccountStructure in CLASSIFY_DEPTH_CAP_MODE=auto and off (#69):
 * when the capped fingerprint reuses the cached classification, and when
 * the weekly full pass runs. Drive, the model and the database are mocked
 * at the module boundary; the cap, the fingerprint and the stage are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifiedFolder, EntityMap, FolderNode } from '../../drive/structure';
import type { StructureCache } from '../days';
import type { EntityCtx } from '../../scan/batch-types';

const m = vi.hoisted(() => ({
  config: { CLASSIFY_DEPTH_CAP_MODE: 'auto', CLASSIFY_DEFAULT_DEPTH_CAP: 5 },
  gather: vi.fn(),
  classify: vi.fn(),
  persist: vi.fn(),
  estimate: vi.fn(),
  warn: vi.fn(),
  campaigns: [] as Array<{ id: string; name: string; driveFolderId: string }>,
}));

vi.mock('../../config', () => ({ config: m.config }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: m.warn, error: vi.fn() },
}));
vi.mock('../../prisma', () => ({
  prisma: {
    campaign: { findMany: vi.fn(async () => m.campaigns) },
    campaignPiece: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('../../drive/structure', async (importActual) => {
  const actual = await importActual<typeof import('../../drive/structure')>();
  m.estimate.mockImplementation(actual.estimateClassifyTokens);
  return {
    ...actual,
    gatherFolders: m.gather,
    classifyFolders: m.classify,
    estimateClassifyTokens: m.estimate,
  };
});
vi.mock('../days', async (importActual) => ({
  ...(await importActual<typeof import('../days')>()),
  persistStructureCache: m.persist,
}));
vi.mock('../../scan/output', () => ({ log: vi.fn(), rule: (t: string) => t }));
vi.mock('../../scan/timing', () => ({ timed: (_phase: string, fn: () => unknown) => fn() }));

import { resolveAccountStructure } from '../structure-stage';
import { structureFingerprint } from '../days';
import { FOLDERS, ANCHORS } from '../../drive/__tests__/fixtures/folder-tree';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-22T07:00:00Z');

// The depth-3 anchor only: classified roots and anchors at depth 3 → cap 4.
const SPRING = ANCHORS.find((a) => a.driveFolderId === 'f-spring')!;
const SHALLOW = FOLDERS.filter((f) => f.depth <= 6);

function classified(
  folderId: string,
  classification: ClassifiedFolder['classification'] = 'new_campaign',
): ClassifiedFolder {
  return {
    folderId,
    folderPath: folderId,
    classification,
    campaignName: folderId,
    matchedCampaignId: classification === 'existing_campaign' ? SPRING.id : null,
    reasoning: 'test',
  };
}

const ROOTS = [classified('f-spring', 'existing_campaign'), classified('f-holiday')];

function entityMap(folders: FolderNode[], entries: ClassifiedFolder[] = ROOTS): EntityMap {
  return {
    accountId: 'acc-1',
    accountName: 'Account One',
    allFolders: folders,
    classified: entries,
    driver: 'mock',
    folderCount: folders.length,
  };
}

function ctx(cache: StructureCache | null): EntityCtx {
  return {
    type: 'account',
    id: 'acc-1',
    accountId: 'acc-1',
    name: 'Account One',
    folderId: 'root-0',
    driveStructureClassification: cache,
  } as unknown as EntityCtx;
}

const resolve = (cache: StructureCache | null, persistCache = true) =>
  resolveAccountStructure(ctx(cache), { trustCache: false, persistCache });

const lastPersisted = (): StructureCache => m.persist.mock.calls.at(-1)![1] as StructureCache;

/** A first run on `folders`: the cache it writes, as the next run reads it. */
async function cacheAfterFirstRun(folders: FolderNode[]): Promise<StructureCache> {
  m.gather.mockResolvedValueOnce(folders);
  m.classify.mockResolvedValueOnce(entityMap(folders));
  await resolve(null);
  const cache = lastPersisted();
  m.classify.mockClear();
  m.persist.mockClear();
  return cache;
}

function withFolder(base: FolderNode[], folder: FolderNode): FolderNode[] {
  return [...base, folder];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  m.config.CLASSIFY_DEPTH_CAP_MODE = 'auto';
  m.campaigns = [SPRING];
  m.gather.mockReset();
  m.classify.mockReset();
  m.classify.mockImplementation(async (args: { folders: FolderNode[] }) => entityMap(args.folders));
  m.persist.mockReset();
  m.warn.mockReset();
});

const classifyArgs = () => m.classify.mock.calls[0]![0] as { depthCap?: number };

afterEach(() => {
  vi.useRealTimers();
});

describe('capped fingerprint (auto)', () => {
  it('reuses the classification when a folder appears below the cap', async () => {
    const cache = await cacheAfterFirstRun(SHALLOW);
    const deeper = withFolder(SHALLOW, {
      id: 'f-new-deep',
      name: 'Round 2',
      depth: 5,
      parentId: 'f-creative',
      path: 'Account One / Clients / 2025 / Spring Launch / Creative / Round 2',
    });
    m.gather.mockResolvedValueOnce(deeper);

    const stage = await resolve(cache);

    expect(m.classify).not.toHaveBeenCalled();
    expect(m.persist).not.toHaveBeenCalled();
    // A file in the new folder still belongs to the enclosing campaign.
    expect(stage.attributor('f-new-deep')).toMatchObject({
      ownerType: 'campaign',
      campaignFolderId: 'f-spring',
    });
  });

  it('reclassifies, capped, when a new root appears at the cap depth', async () => {
    const cache: StructureCache = {
      ...(await cacheAfterFirstRun(SHALLOW)),
      fullPassAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
    };
    const newRoot = withFolder(SHALLOW, {
      id: 'f-new-root',
      name: 'Summer Promo',
      depth: 4,
      parentId: 'f-oldpitch',
      path: 'Account One / Clients / Archive / Old Pitch / Summer Promo',
    });
    m.gather.mockResolvedValueOnce(newRoot);
    m.classify.mockResolvedValueOnce(entityMap(newRoot));

    await resolve(cache);

    expect(m.classify).toHaveBeenCalledTimes(1);
    expect(m.classify).toHaveBeenCalledWith(expect.objectContaining({ depthCap: 4 }));
    expect(lastPersisted().fullPassAt).toBe(cache.fullPassAt);
  });

  it('does not reclassify an unchanged tree after the cap moved', async () => {
    const cache = await cacheAfterFirstRun(SHALLOW);
    const newRoot = withFolder(SHALLOW, {
      id: 'f-new-root',
      name: 'Summer Promo',
      depth: 4,
      parentId: 'f-oldpitch',
      path: 'Account One / Clients / Archive / Old Pitch / Summer Promo',
    });
    // The reclassify finds the depth-4 root: the next cap is 5, not 4.
    m.gather.mockResolvedValueOnce(newRoot);
    m.classify.mockResolvedValueOnce(entityMap(newRoot, [...ROOTS, classified('f-new-root')]));
    await resolve(cache);
    const next = lastPersisted();
    m.classify.mockClear();

    m.gather.mockResolvedValueOnce(newRoot);
    await resolve(next);

    expect(m.classify).not.toHaveBeenCalled();
  });

  it('caps at the deepest campaign root, not at a deep account_level entry', async () => {
    const cache = await cacheAfterFirstRun(SHALLOW);
    const stale: StructureCache = {
      ...cache,
      fingerprint: 'stale',
      entityMap: entityMap(SHALLOW, [...ROOTS, classified('f-exports', 'account_level')]),
    };
    m.gather.mockResolvedValueOnce(SHALLOW);
    m.classify.mockResolvedValueOnce(entityMap(SHALLOW));

    await resolve(stale);

    expect(m.classify).toHaveBeenCalledWith(expect.objectContaining({ depthCap: 4 }));
  });
});

describe('weekly full pass (auto)', () => {
  it('classifies the whole tree once the last full pass is over 7 days old', async () => {
    const cache = await cacheAfterFirstRun(SHALLOW);
    const old: StructureCache = {
      ...cache,
      fullPassAt: new Date(NOW.getTime() - 8 * DAY_MS).toISOString(),
    };
    m.gather.mockResolvedValueOnce(SHALLOW);
    m.classify.mockResolvedValueOnce(entityMap(SHALLOW));

    await resolve(old);

    expect(m.classify).toHaveBeenCalledTimes(1);
    expect(classifyArgs().depthCap).toBeUndefined();
    expect(lastPersisted().fullPassAt).toBe(NOW.toISOString());
  });

  it('stays on the cached classification while the last full pass is under 7 days old', async () => {
    const cache = await cacheAfterFirstRun(SHALLOW);
    const recent: StructureCache = {
      ...cache,
      fullPassAt: new Date(NOW.getTime() - 6 * DAY_MS).toISOString(),
    };
    m.gather.mockResolvedValueOnce(SHALLOW);

    await resolve(recent);

    expect(m.classify).not.toHaveBeenCalled();
  });

  it('runs a weekly schedule that fires a little early', async () => {
    const cache = await cacheAfterFirstRun(SHALLOW);
    const lastWeek: StructureCache = {
      ...cache,
      fullPassAt: new Date(NOW.getTime() - 7 * DAY_MS + 60_000).toISOString(),
    };
    m.gather.mockResolvedValueOnce(SHALLOW);
    m.classify.mockResolvedValueOnce(entityMap(SHALLOW));

    await resolve(lastWeek);

    expect(m.classify).toHaveBeenCalledTimes(1);
    expect(classifyArgs().depthCap).toBeUndefined();
  });

  it('stays capped and warns when the whole tree is over the input limit', async () => {
    m.estimate.mockReturnValueOnce(2_000_000);
    m.gather.mockResolvedValueOnce(SHALLOW);
    m.classify.mockResolvedValueOnce(entityMap(SHALLOW));

    await resolve(null);

    expect(m.warn).toHaveBeenCalledWith(
      {
        accountId: 'acc-1',
        folders: SHALLOW.length,
        estimatedTokens: 2_000_000,
        inputTokenLimit: 1_048_576,
        depthCap: 5,
      },
      '[drive.structure] full pass over the input limit; staying capped',
    );
    expect(m.classify).toHaveBeenCalledWith(expect.objectContaining({ depthCap: 5 }));
    expect(lastPersisted().fullPassAt).toBeUndefined();
  });
});

describe('weekly full pass, failure paths (auto)', () => {
  const dueCache = async (): Promise<StructureCache> => ({
    ...(await cacheAfterFirstRun(SHALLOW)),
    fullPassAt: new Date(NOW.getTime() - 8 * DAY_MS).toISOString(),
  });

  it('falls back to the cached classification when the full pass fails, and records it', async () => {
    const cache = await dueCache();
    m.gather.mockResolvedValueOnce(SHALLOW);
    m.classify.mockRejectedValueOnce(new Error('deadline exceeded'));

    const stage = await resolve(cache);

    expect(m.classify).toHaveBeenCalledTimes(1);
    expect(m.warn).toHaveBeenCalledWith(
      { accountId: 'acc-1', folders: SHALLOW.length, depthCap: 4, error: 'deadline exceeded' },
      '[drive.structure] full pass failed; staying capped',
    );
    expect(lastPersisted()).toEqual({ ...cache, fullPassAt: NOW.toISOString() });
    expect(stage.attributor('f-decks')).toMatchObject({ campaignFolderId: 'f-holiday' });
  });

  it('classifies capped when the full pass fails on a changed tree', async () => {
    const cache = await dueCache();
    const newRoot = withFolder(SHALLOW, {
      id: 'f-new-root',
      name: 'Summer Promo',
      depth: 4,
      parentId: 'f-oldpitch',
      path: 'Account One / Clients / Archive / Old Pitch / Summer Promo',
    });
    m.gather.mockResolvedValueOnce(newRoot);
    m.classify.mockRejectedValueOnce(new Error('input too long'));

    await resolve(cache);

    expect(m.classify).toHaveBeenCalledTimes(2);
    expect(m.classify.mock.calls[0]![0]).toMatchObject({ depthCap: undefined });
    expect(m.classify.mock.calls[1]![0]).toMatchObject({ depthCap: 4 });
    expect(lastPersisted().fullPassAt).toBe(NOW.toISOString());
  });

  it('treats a future fullPassAt as due', async () => {
    const cache: StructureCache = {
      ...(await cacheAfterFirstRun(SHALLOW)),
      fullPassAt: new Date(NOW.getTime() + 3 * DAY_MS).toISOString(),
    };
    m.gather.mockResolvedValueOnce(SHALLOW);

    await resolve(cache);

    expect(m.classify).toHaveBeenCalledTimes(1);
    expect(classifyArgs().depthCap).toBeUndefined();
  });

  it('reuses a valid cache, with the warning, when the whole tree is over the limit', async () => {
    const cache = await dueCache();
    m.estimate.mockReturnValueOnce(2_000_000);
    m.gather.mockResolvedValueOnce(SHALLOW);

    await resolve(cache);

    expect(m.warn).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedTokens: 2_000_000 }),
      '[drive.structure] full pass over the input limit; staying capped',
    );
    expect(m.classify).not.toHaveBeenCalled();
    expect(m.persist).not.toHaveBeenCalled();
  });

  it('runs no full pass in a dry run, which cannot record it', async () => {
    m.gather.mockResolvedValueOnce(SHALLOW);

    await resolve(null, false);

    expect(m.classify).toHaveBeenCalledTimes(1);
    expect(classifyArgs().depthCap).toBe(5);
    expect(m.persist).not.toHaveBeenCalled();
  });
});

describe('off mode', () => {
  it('fingerprints and classifies the whole tree, and writes no fullPassAt', async () => {
    m.config.CLASSIFY_DEPTH_CAP_MODE = 'off';
    m.gather.mockResolvedValueOnce(SHALLOW);
    m.classify.mockResolvedValueOnce(entityMap(SHALLOW));

    await resolve(null);

    expect(classifyArgs().depthCap).toBeUndefined();
    expect(lastPersisted()).toStrictEqual({
      fingerprint: structureFingerprint(
        SHALLOW.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
      ),
      entityMap: entityMap(SHALLOW),
      folders: SHALLOW,
    });
    expect(Object.keys(lastPersisted())).toEqual(['fingerprint', 'entityMap', 'folders']);
    expect(m.warn).not.toHaveBeenCalled();
  });
});
