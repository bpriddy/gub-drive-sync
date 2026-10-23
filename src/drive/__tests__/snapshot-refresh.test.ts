import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

interface LatestRow {
  fileId: string;
  name: string;
  path: string | null;
  mimeType: string | null;
  modifiedTime: Date | null;
  campaignId: string | null;
  syncRunId: string | null;
}

const m = vi.hoisted(() => ({
  db: {
    accounts: [] as Array<{ id: string; name: string; driveFolderId: string }>,
    campaigns: [] as Array<{ id: string; driveFolderId: string }>,
    pieces: [] as Array<{ campaignId: string; driveFolderId: string }>,
    /** What `DISTINCT ON (file_id) … ORDER BY scanned_at DESC` returns. */
    latest: [] as LatestRow[],
    /** The account-scoped rows of a v1 run: what the sibling query returns. */
    siblings: [] as Array<{ fileId: string; syncRunId: string; path: string | null }>,
    created: [] as Array<Record<string, unknown>>,
    /** File ids whose insert is refused. */
    refused: new Map<string, unknown>(),
  },
  probe: vi.fn(),
  listSubtree: vi.fn(),
  walk: {
    entries: [] as Array<Record<string, unknown>>,
    /** onFolderError calls the mocked walk makes before it yields. */
    unreadable: 0,
    calls: 0,
  },
  warn: vi.fn(),
}));

vi.mock('../../prisma', () => ({
  prisma: {
    account: {
      findMany: vi.fn(async ({ where }: { where: { id?: string } }) =>
        m.db.accounts.filter((a) => !where.id || a.id === where.id),
      ),
    },
    campaign: { findMany: vi.fn(async () => m.db.campaigns) },
    campaignPiece: { findMany: vi.fn(async () => m.db.pieces) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('unnest')) {
        const [fileIds, runIds] = values as [string[], string[]];
        return fileIds.flatMap((fileId, i) =>
          m.db.siblings.filter((s) => s.fileId === fileId && s.syncRunId === runIds[i]),
        );
      }
      const ids = values[0] as string[];
      return m.db.latest.filter((r) => ids.includes(r.fileId));
    }),
    driveFileSnapshot: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const refusal = m.db.refused.get(data['fileId'] as string);
        if (refusal) throw refusal;
        m.db.created.push(data);
        return data;
      }),
    },
  },
}));
vi.mock('../../logger', () => ({ logger: { warn: m.warn } }));
vi.mock('../client', () => ({
  probeFolder: m.probe,
  // A 404 is the refusal; anything else is not.
  isListingUnavailableError: (err: unknown) => (err as { code?: number }).code === 404,
  listingFailureCause: () => 'HTTP 404',
}));
vi.mock('../subtree', () => ({ listSubtreeFiles: m.listSubtree }));
vi.mock('../traversal', () => ({
  traverseFolder: async function* (
    _root: string,
    _label: string,
    options: { onFolderError?: () => void },
  ) {
    m.walk.calls++;
    for (let i = 0; i < m.walk.unreadable; i++) options.onFolderError?.();
    for (const e of m.walk.entries) yield e;
  },
}));

import { setLogCapture } from '../../scan/output';
import {
  isLegacyCampaignRow,
  nearestCampaignId,
  parseRefreshSnapshotsArgs,
  refreshFileSnapshots,
  snapshotRefreshReason,
  type LatestSnapshot,
} from '../snapshot-refresh';
import type { TraversedFile } from '../types';

const ROOT = 'root';
const DRIVE = 'drive-1';
const RUN = '11111111-1111-4111-8111-111111111111';

function f(over: Partial<TraversedFile> & { id: string }): TraversedFile {
  return {
    name: `${over.id}.pdf`,
    mimeType: 'application/pdf',
    parents: [ROOT],
    path: `Acme / ${over.id}.pdf`,
    modifiedTime: '2026-09-01T12:00:00.000Z',
    modifiedByEmail: null,
    createdTime: null,
    size: null,
    isFolder: false,
    ...over,
  };
}

/** The latest row that already describes `file`, unless overridden. */
function latestOf(file: TraversedFile, over: Partial<LatestSnapshot> = {}): LatestSnapshot {
  return {
    fileId: file.id,
    name: file.name,
    path: file.path,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
    campaignId: null,
    syncRunId: null,
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
    expect(snapshotRefreshReason(file, latestOf(file, { path: 'Acme / Old / a.pdf' }))).toBe(
      'moved',
    );
    expect(snapshotRefreshReason(file, latestOf(file, { path: null }))).toBe('moved');
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

  describe('a v1 campaign row, whose path is rooted at the campaign name', () => {
    const inCampaign = f({ id: 'c', path: 'Acme / 2026 / Q3 Launch / c.pdf' });
    const legacy = latestOf(inCampaign, {
      path: 'Q3 Launch / c.pdf',
      campaignId: 'camp-1',
      syncRunId: RUN,
    });

    it('is a false move when compared as it is', () => {
      expect(snapshotRefreshReason(inCampaign, legacy)).toBe('moved');
    });

    it('is not moved when the run’s account-rooted path still matches', () => {
      expect(
        snapshotRefreshReason(inCampaign, legacy, 'Acme / 2026 / Q3 Launch / c.pdf'),
      ).toBeNull();
    });

    it('is moved when the folder really moved since: the account-rooted path differs too', () => {
      expect(snapshotRefreshReason(inCampaign, legacy, 'Acme / 2025 / Q3 Launch / c.pdf')).toBe(
        'moved',
      );
    });

    it('still reports a rename, a new version and a mime change', () => {
      const accountRooted = 'Acme / 2026 / Q3 Launch / c.pdf';
      expect(snapshotRefreshReason(inCampaign, { ...legacy, name: 'old.pdf' }, accountRooted)).toBe(
        'renamed',
      );
      expect(
        snapshotRefreshReason(
          inCampaign,
          { ...legacy, modifiedTime: new Date('2026-08-01T00:00:00Z') },
          accountRooted,
        ),
      ).toBe('modified');
      expect(
        snapshotRefreshReason(inCampaign, { ...legacy, mimeType: 'text/plain' }, accountRooted),
      ).toBe('mime_changed');
    });
  });
});

describe('isLegacyCampaignRow', () => {
  it('is a v1 row (run id) written by a campaign scan (campaign id)', () => {
    expect(isLegacyCampaignRow({ syncRunId: RUN, campaignId: 'camp-1' })).toBe(true);
    // A v1 account scan: account-rooted already.
    expect(isLegacyCampaignRow({ syncRunId: RUN, campaignId: null })).toBe(false);
    // The scan core and this catch-up leave sync_run_id NULL.
    expect(isLegacyCampaignRow({ syncRunId: null, campaignId: 'camp-1' })).toBe(false);
    expect(isLegacyCampaignRow({ syncRunId: null, campaignId: null })).toBe(false);
  });
});

describe('nearestCampaignId', () => {
  const parentOf = new Map<string, string | null>([
    ['camp-folder', null],
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
    expect(nearestCampaignId(f({ id: 'x', parents: [ROOT] }), parentOf, byFolder)).toBeNull();
    expect(nearestCampaignId(f({ id: 'x', parents: ['loop-a'] }), parentOf, byFolder)).toBeNull();
    expect(nearestCampaignId(f({ id: 'x', parents: [] }), parentOf, byFolder)).toBeNull();
  });
});

describe('refreshFileSnapshots', () => {
  // Account-level files, and files inside the Q3 Launch campaign folder.
  const unchanged = f({ id: 'f-unchanged', name: 'Unchanged.pdf', path: 'Acme / Unchanged.pdf' });
  const renamed = f({ id: 'f-renamed', name: 'Renamed Deck.pdf', path: 'Acme / Renamed Deck.pdf' });
  const fresh = f({
    id: 'f-fresh',
    name: 'Fresh Brief.pdf',
    parents: ['q3-folder'],
    path: 'Acme / Q3 Launch / Fresh Brief.pdf',
  });
  // v1 left a campaign-rooted row, written after the run's account-rooted one.
  const legacySame = f({
    id: 'f-legacy-same',
    name: 'Legacy Same.pdf',
    parents: ['q3-folder'],
    path: 'Acme / Q3 Launch / Legacy Same.pdf',
  });
  const legacyMoved = f({
    id: 'f-legacy-moved',
    name: 'Legacy Moved.pdf',
    parents: ['q3-folder'],
    path: 'Acme / Q3 Launch / Legacy Moved.pdf',
  });
  const legacyNoSibling = f({
    id: 'f-legacy-nosib',
    name: 'Legacy NoSib.pdf',
    parents: ['q3-folder'],
    path: 'Acme / Q3 Launch / Legacy NoSib.pdf',
  });
  const everyFile = [unchanged, renamed, fresh, legacySame, legacyMoved, legacyNoSibling];
  const FOLDERS = [
    { id: 'q3-folder', name: 'Q3 Launch', path: 'Acme / Q3 Launch', depth: 1, parentId: null },
  ];

  let lines: string[];

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    lines = [];
    setLogCapture(lines);
    m.warn.mockClear();
    m.probe.mockReset();
    m.listSubtree.mockReset();
    m.db.accounts = [{ id: 'acct-1', name: 'Acme', driveFolderId: ROOT }];
    m.db.campaigns = [{ id: 'camp-q3', driveFolderId: 'q3-folder' }];
    m.db.pieces = [];
    m.db.created = [];
    m.db.refused = new Map();
    m.db.latest = [
      latestOf(unchanged),
      latestOf(renamed, { name: 'Renamed Deck v1.pdf' }),
      latestOf(legacySame, {
        path: 'Q3 Launch / Legacy Same.pdf',
        campaignId: 'camp-q3',
        syncRunId: RUN,
      }),
      latestOf(legacyMoved, {
        path: 'Q3 Launch / Legacy Moved.pdf',
        campaignId: 'camp-q3',
        syncRunId: RUN,
      }),
      latestOf(legacyNoSibling, {
        path: 'Q3 Launch / Legacy NoSib.pdf',
        campaignId: 'camp-q3',
        syncRunId: RUN,
      }),
    ];
    m.db.siblings = [
      { fileId: legacySame.id, syncRunId: RUN, path: legacySame.path },
      { fileId: legacyMoved.id, syncRunId: RUN, path: 'Acme / Old Place / Legacy Moved.pdf' },
    ];
    // The walk would list the same tree as the flat listing below.
    m.walk.entries = [
      ...FOLDERS.map((d) => f({ id: d.id, name: d.name, path: d.path, isFolder: true })),
      ...everyFile,
    ];
    m.walk.unreadable = 0;
    m.walk.calls = 0;
    // A folder inside a shared drive: the flat listing.
    m.probe.mockResolvedValue({ isSharedDriveRoot: false, driveId: DRIVE, mimeType: null });
    m.listSubtree.mockResolvedValue({
      files: everyFile,
      folders: FOLDERS,
      folderCount: 1,
      depthCapHits: 0,
      stats: {},
    });
  });

  afterEach(() => {
    setLogCapture(null);
    vi.restoreAllMocks();
  });

  const output = () => lines.join('\n');

  it('dry-run counts what it would write and writes nothing', async () => {
    const res = await refreshFileSnapshots({});

    expect(res).toMatchObject({
      confirm: false,
      accounts: 1,
      filesSeen: 6,
      rowsPlanned: 4,
      rowsWritten: 0,
      writeFailures: 0,
      // Without normalization the legacy-same file would be a fifth, false, move.
      byReason: { unindexed: 1, renamed: 1, moved: 2, modified: 0, mime_changed: 0 },
      legacyNormalized: 2,
      legacyUnresolved: 1,
    });
    expect(m.db.created).toEqual([]);
    expect(output()).toContain('dry-run');
    expect(output()).toContain('4 row(s) would be written');
  });

  it('with --confirm writes exactly the planned rows, as listing-only rows', async () => {
    const res = await refreshFileSnapshots({ confirm: true });

    expect(res).toMatchObject({ confirm: true, rowsPlanned: 4, rowsWritten: 4, writeFailures: 0 });
    expect(m.db.created.map((r) => r.fileId)).toEqual([
      'f-renamed',
      'f-fresh',
      'f-legacy-moved',
      'f-legacy-nosib',
    ]);
    for (const row of m.db.created) {
      expect(row).toMatchObject({
        accountId: 'acct-1',
        wasExtracted: false,
        skipReason: 'index_refresh',
        // sync_run_id references the v1 sync_runs table: never stamped here.
        syncRunId: null,
        contentHash: null,
      });
    }
    // The new row carries the listing's account-rooted path and the folder's campaign.
    expect(m.db.created[1]).toMatchObject({
      name: 'Fresh Brief.pdf',
      path: 'Acme / Q3 Launch / Fresh Brief.pdf',
      campaignId: 'camp-q3',
    });
    expect(m.db.created[0]).toMatchObject({ name: 'Renamed Deck.pdf', campaignId: null });
  });

  it('does not count a legacy campaign-rooted row as moved, but counts a folder that really moved', async () => {
    const res = await refreshFileSnapshots({ confirm: true });

    const written = m.db.created.map((r) => r.fileId);
    // Same account-rooted path as the v1 run saw: left alone.
    expect(written).not.toContain('f-legacy-same');
    // The run's account-rooted row says the file sat elsewhere.
    expect(written).toContain('f-legacy-moved');
    // No account-rooted row to compare with: compared as it is, and counted.
    expect(written).toContain('f-legacy-nosib');
    expect(res).toMatchObject({ legacyNormalized: 2, legacyUnresolved: 1 });
  });

  it('is a no-op on the second run', async () => {
    await refreshFileSnapshots({ confirm: true });
    // What DISTINCT ON … scanned_at DESC returns now: the row just written.
    const newest = new Map(m.db.latest.map((r) => [r.fileId, r]));
    for (const r of m.db.created) {
      newest.set(r['fileId'] as string, {
        fileId: r['fileId'] as string,
        name: r['name'] as string,
        path: r['path'] as string,
        mimeType: r['mimeType'] as string,
        modifiedTime: r['modifiedTime'] as Date,
        campaignId: r['campaignId'] as string | null,
        syncRunId: null,
      });
    }
    m.db.latest = [...newest.values()];
    m.db.created = [];

    const res = await refreshFileSnapshots({ confirm: true });

    expect(res.rowsPlanned).toBe(0);
    expect(m.db.created).toEqual([]);
    // The legacy files nobody wrote a row for are still compared, still unchanged.
    expect(res).toMatchObject({ legacyNormalized: 1, legacyUnresolved: 0 });
  });

  it('prints counts only: no file name, path, id or account name', async () => {
    await refreshFileSnapshots({ confirm: true });
    await refreshFileSnapshots({});

    const text = output();
    expect(text).toContain('account acct-1');
    for (const file of [...everyFile]) {
      for (const secret of [file.id, file.name, file.path]) expect(text).not.toContain(secret);
    }
    for (const secret of ['Acme', 'Q3 Launch', 'Old Place', 'camp-q3', 'q3-folder']) {
      expect(text).not.toContain(secret);
    }
    // And no per-file lines at all: one line per account and the totals.
    expect(lines.filter((l) => l.startsWith('  account '))).toHaveLength(2);
  });

  it('indexes a file listed twice once, under its first path', async () => {
    const again = { ...fresh, path: 'Acme / Elsewhere / Fresh Brief.pdf' };
    m.listSubtree.mockResolvedValue({
      files: [fresh, again],
      folders: FOLDERS,
      folderCount: 1,
      depthCapHits: 0,
      stats: {},
    });

    const res = await refreshFileSnapshots({ confirm: true });

    expect(res.filesSeen).toBe(1);
    expect(m.db.created.map((r) => r.path)).toEqual(['Acme / Q3 Launch / Fresh Brief.pdf']);
  });

  describe('which listing', () => {
    it('lists a root inside a shared drive flat, labelled with the account name', async () => {
      await refreshFileSnapshots({});

      expect(m.probe).toHaveBeenCalledWith(ROOT);
      expect(m.listSubtree).toHaveBeenCalledWith(ROOT, 'Acme', DRIVE);
      expect(m.walk.calls).toBe(0);
      expect(output()).toContain('(flat)');
    });

    it('lists the drive root flat too', async () => {
      m.probe.mockResolvedValue({ isSharedDriveRoot: true, driveId: ROOT, mimeType: null });

      await refreshFileSnapshots({});

      expect(m.listSubtree).toHaveBeenCalledWith(ROOT, 'Acme', ROOT);
      expect(m.walk.calls).toBe(0);
    });

    it('walks a My Drive root, attributing files through the walked folders', async () => {
      m.probe.mockResolvedValue({ isSharedDriveRoot: false, driveId: null, mimeType: null });
      m.walk.entries = [
        { ...f({ id: 'q3-folder', name: 'Q3 Launch', path: 'Acme / Q3 Launch' }), isFolder: true },
        {
          ...f({ id: 'sub', name: 'Decks', path: 'Acme / Q3 Launch / Decks' }),
          isFolder: true,
          parents: ['q3-folder'],
        },
        f({ id: 'f-deep', parents: ['sub'], path: 'Acme / Q3 Launch / Decks / f-deep.pdf' }),
      ];

      const res = await refreshFileSnapshots({ confirm: true });

      expect(m.listSubtree).not.toHaveBeenCalled();
      expect(output()).toContain('(walk)');
      expect(res).toMatchObject({ filesSeen: 1, rowsWritten: 1 });
      expect(m.db.created[0]).toMatchObject({ fileId: 'f-deep', campaignId: 'camp-q3' });
    });

    it('falls back to the walk when the drive listing is refused for a folder inside a drive', async () => {
      m.listSubtree.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
      m.walk.entries = [f({ id: 'f-walked' })];

      const res = await refreshFileSnapshots({});

      expect(res.filesSeen).toBe(1);
      expect(m.walk.calls).toBe(1);
      expect(output()).toContain(
        'flat listing unavailable (HTTP 404) — falling back to the recursive walk',
      );
      expect(output()).toContain('(walk)');
    });

    it('lets a refusal of the drive root itself through: the walk would be refused too', async () => {
      m.probe.mockResolvedValue({ isSharedDriveRoot: true, driveId: ROOT, mimeType: null });
      const refusal = Object.assign(new Error('not found'), { code: 404 });
      m.listSubtree.mockRejectedValue(refusal);

      await expect(refreshFileSnapshots({})).rejects.toBe(refusal);
      expect(m.walk.calls).toBe(0);
    });

    it('lets any other listing error through, with no fallback', async () => {
      const failure = Object.assign(new Error('backend error'), { code: 500 });
      m.listSubtree.mockRejectedValue(failure);

      await expect(refreshFileSnapshots({ confirm: true })).rejects.toBe(failure);
      expect(m.walk.calls).toBe(0);
      expect(m.db.created).toEqual([]);
    });

    it('reports what the listing could not see, as a count', async () => {
      m.probe.mockResolvedValue({ isSharedDriveRoot: false, driveId: null, mimeType: null });
      m.walk.entries = [f({ id: 'f-visible' })];
      m.walk.unreadable = 2;

      await refreshFileSnapshots({});

      expect(output()).toContain('files in 2 unreadable subfolder(s) not listed');
    });
  });

  it('only looks at the account asked for, and refuses an id that matches none', async () => {
    m.db.accounts = [
      { id: 'acct-1', name: 'Acme', driveFolderId: ROOT },
      { id: 'acct-2', name: 'Globex', driveFolderId: 'other-root' },
    ];

    const res = await refreshFileSnapshots({ accountId: 'acct-2' });
    expect(res.accounts).toBe(1);
    expect(m.probe).toHaveBeenCalledTimes(1);
    expect(m.probe).toHaveBeenCalledWith('other-root');

    await expect(refreshFileSnapshots({ accountId: 'acct-typo' })).rejects.toThrow(
      /no account with that id/,
    );
  });

  describe('a row that cannot be written', () => {
    const fkViolation = () =>
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
        code: 'P2003',
        clientVersion: '5.22.0',
        meta: { field_name: 'drive_file_snapshots_account_id_fkey (index)' },
      });

    it('is counted, reported without its values, and fails the run after the summary', async () => {
      m.db.refused.set('f-fresh', fkViolation());

      await expect(refreshFileSnapshots({ confirm: true })).rejects.toThrow(
        /1 snapshot write failure\(s\) — see the \[drive\.snapshot\] WARN lines/,
      );

      // The rest is still written (append-only, partial progress is fine).
      expect(m.db.created.map((r) => r.fileId)).toEqual([
        'f-renamed',
        'f-legacy-moved',
        'f-legacy-nosib',
      ]);
      expect(m.warn).toHaveBeenCalledTimes(1);
      expect(m.warn).toHaveBeenCalledWith(
        {
          fileId: 'f-fresh',
          accountId: 'acct-1',
          source: 'refresh',
          code: 'P2003',
          constraint: 'drive_file_snapshots_account_id_fkey (index)',
        },
        '[drive.snapshot] write failed',
      );
      // The summary was printed before the throw, with the failure counted by cause.
      expect(output()).toContain('3 of 4 row(s) written');
      expect(output()).toContain(
        '1 write failure(s) [P2003 drive_file_snapshots_account_id_fkey (index) x1]',
      );
      expect(output()).not.toContain('Fresh Brief');
    });

    it('does not fail a dry-run, which writes nothing', async () => {
      m.db.refused.set('f-fresh', fkViolation());

      await expect(refreshFileSnapshots({})).resolves.toMatchObject({ writeFailures: 0 });
      expect(m.warn).not.toHaveBeenCalled();
    });
  });
});

describe('parseRefreshSnapshotsArgs', () => {
  it('reads an account id and --confirm, in either form', () => {
    expect(parseRefreshSnapshotsArgs([])).toEqual({ confirm: false });
    expect(parseRefreshSnapshotsArgs(['--confirm'])).toEqual({ confirm: true });
    expect(parseRefreshSnapshotsArgs(['--account-id', 'acct-1'])).toEqual({
      accountId: 'acct-1',
      confirm: false,
    });
    expect(parseRefreshSnapshotsArgs(['--account-id=acct-1', '--confirm'])).toEqual({
      accountId: 'acct-1',
      confirm: true,
    });
  });

  it('refuses a flag where the account id should be', () => {
    expect(() => parseRefreshSnapshotsArgs(['--account-id', '--confirm'])).toThrow(
      /--account-id needs a value/,
    );
  });

  it('refuses a missing or empty account id', () => {
    for (const args of [['--account-id'], ['--account-id='], ['--confirm', '--account-id']]) {
      expect(() => parseRefreshSnapshotsArgs(args)).toThrow(/--account-id needs a value/);
    }
  });

  it('refuses anything it does not know, so a typo cannot widen the scope', () => {
    for (const arg of ['--bogus', '--confirm=true', 'acct-1', '--account']) {
      expect(() => parseRefreshSnapshotsArgs([arg])).toThrow(/unknown argument/);
    }
  });
});
