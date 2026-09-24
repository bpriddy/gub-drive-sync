import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { db, tree } = vi.hoisted(() => ({
  db: {
    accounts: [] as Array<{ id: string; name: string; driveFolderId: string }>,
    campaigns: [] as Array<{ id: string; driveFolderId: string }>,
    pieces: [] as Array<{ campaignId: string; driveFolderId: string }>,
    latest: [] as Array<Record<string, unknown>>,
    created: [] as Array<Record<string, unknown>>,
  },
  tree: { entries: [] as Array<Record<string, unknown>> },
}));

vi.mock('../../prisma', () => ({
  prisma: {
    account: { findMany: vi.fn(async () => db.accounts) },
    campaign: { findMany: vi.fn(async () => db.campaigns) },
    campaignPiece: { findMany: vi.fn(async () => db.pieces) },
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ids: string[]) =>
      db.latest.filter((r) => ids.includes(r.fileId as string)),
    ),
    driveFileSnapshot: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.created.push(data);
        return data;
      }),
    },
  },
}));
vi.mock('../traversal', () => ({
  traverseFolder: async function* () {
    for (const e of tree.entries) yield e;
  },
}));

import {
  nearestCampaignId,
  refreshFileSnapshots,
  snapshotRefreshReason,
  type LatestSnapshot,
} from '../snapshot-refresh';
import type { TraversedFile } from '../types';

function f(over: Partial<TraversedFile> & { id: string }): TraversedFile {
  return {
    name: `${over.id}.pdf`,
    mimeType: 'application/pdf',
    parents: ['root'],
    path: `Chevy / ${over.id}.pdf`,
    modifiedTime: '2026-09-01T12:00:00.000Z',
    modifiedByEmail: null,
    createdTime: null,
    size: null,
    isFolder: false,
    ...over,
  };
}

function latestOf(file: TraversedFile, over: Partial<LatestSnapshot> = {}): LatestSnapshot {
  return {
    fileId: file.id,
    name: file.name,
    path: file.path,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
    ...over,
  };
}

describe('snapshotRefreshReason', () => {
  const file = f({ id: 'a' });

  it('is null when the latest row already describes the file', () => {
    expect(snapshotRefreshReason(file, latestOf(file))).toBeNull();
  });

  it('flags a file with no row at all', () => {
    expect(snapshotRefreshReason(file, undefined)).toBe('unindexed');
  });

  it('flags a rename — the case file search misses', () => {
    expect(snapshotRefreshReason(file, latestOf(file, { name: 'old name.pdf' }))).toBe('renamed');
  });

  it('flags a move, a newer version and a mime change', () => {
    expect(snapshotRefreshReason(file, latestOf(file, { path: 'Chevy / Old / a.pdf' }))).toBe(
      'moved',
    );
    expect(
      snapshotRefreshReason(
        file,
        latestOf(file, { modifiedTime: new Date('2026-08-01T00:00:00Z') }),
      ),
    ).toBe('modified');
    expect(snapshotRefreshReason(file, latestOf(file, { mimeType: 'text/plain' }))).toBe(
      'mime_changed',
    );
  });

  it('treats two missing modified times as equal', () => {
    const undated = f({ id: 'u', modifiedTime: null });
    expect(snapshotRefreshReason(undated, latestOf(undated))).toBeNull();
  });
});

describe('nearestCampaignId', () => {
  const parentOf = new Map<string, string | null>([
    ['camp-folder', 'root'],
    ['piece-folder', 'camp-folder'],
    ['deep', 'piece-folder'],
    ['loop-a', 'loop-b'],
    ['loop-b', 'loop-a'],
  ]);
  const byFolder = new Map([
    ['camp-folder', 'camp-1'],
    ['piece-folder', 'camp-2'],
  ]);

  it('takes the NEAREST owning folder, so a piece folder beats its campaign', () => {
    expect(nearestCampaignId(f({ id: 'x', parents: ['deep'] }), parentOf, byFolder)).toBe('camp-2');
    expect(nearestCampaignId(f({ id: 'x', parents: ['camp-folder'] }), parentOf, byFolder)).toBe(
      'camp-1',
    );
  });

  it('returns null for account-level files and for a parent cycle', () => {
    expect(nearestCampaignId(f({ id: 'x', parents: ['root'] }), parentOf, byFolder)).toBeNull();
    expect(nearestCampaignId(f({ id: 'x', parents: ['loop-a'] }), parentOf, byFolder)).toBeNull();
    expect(nearestCampaignId(f({ id: 'x', parents: [] }), parentOf, byFolder)).toBeNull();
  });
});

describe('refreshFileSnapshots', () => {
  const unchanged = f({ id: 'unchanged' });
  const renamed = f({ id: 'renamed', name: 'BHAC 30s Teaser v2.mov' });
  const fresh = f({ id: 'fresh', parents: ['camp-folder'], path: 'Chevy / BHAC / fresh.pdf' });

  beforeEach(() => {
    db.accounts = [{ id: 'acct-1', name: 'Chevy', driveFolderId: 'root' }];
    db.campaigns = [{ id: 'camp-bhac', driveFolderId: 'camp-folder' }];
    db.pieces = [];
    db.latest = [latestOf(unchanged), latestOf(renamed, { name: 'BHAC 30s Teaser.mov' })];
    db.created = [];
    tree.entries = [
      { id: 'camp-folder', name: 'BHAC', isFolder: true, parents: ['root'] },
      unchanged,
      renamed,
      fresh,
    ];
  });

  it('dry-run counts what it would write and writes nothing', async () => {
    const res = await refreshFileSnapshots({});
    expect(res).toMatchObject({ filesSeen: 3, rowsPlanned: 2, rowsWritten: 0, confirm: false });
    expect(res.byReason).toMatchObject({ renamed: 1, unindexed: 1 });
    expect(db.created).toEqual([]);
  });

  it('with --confirm writes only the stale files, as listing-only rows', async () => {
    const res = await refreshFileSnapshots({ confirm: true });
    expect(res.rowsWritten).toBe(2);
    expect(db.created.map((r) => r.fileId)).toEqual(['renamed', 'fresh']);
    expect(db.created[1]).toMatchObject({
      accountId: 'acct-1',
      campaignId: 'camp-bhac',
      name: 'fresh.pdf',
      path: 'Chevy / BHAC / fresh.pdf',
      wasExtracted: false,
      skipReason: 'index_refresh',
      syncRunId: null,
    });
  });

  it('is a no-op on the second run', async () => {
    await refreshFileSnapshots({ confirm: true });
    // What DISTINCT ON (file_id) … scanned_at DESC now returns: the newest row per file.
    const newest = new Map(db.latest.map((r) => [r.fileId, r]));
    for (const r of db.created) {
      newest.set(r.fileId, {
        fileId: r.fileId,
        name: r.name,
        path: r.path,
        mimeType: r.mimeType,
        modifiedTime: r.modifiedTime,
      });
    }
    db.latest = [...newest.values()];
    db.created = [];

    const res = await refreshFileSnapshots({ confirm: true });
    expect(res.rowsPlanned).toBe(0);
    expect(db.created).toEqual([]);
  });
});
