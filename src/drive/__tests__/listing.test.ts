import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDriveApi, file, folder, listCalls, resetFakeDrive, type FakeItem } from './fake-drive';

// The real client, structure and discovery code, over a fake Drive. Only the
// edges are stubbed: googleapis (the fake), the bot credential lookup (DB),
// and the LLM module (never called — gatherFolders does not classify).
vi.mock('googleapis', () => ({ google: { drive: () => fakeDriveApi } }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: async () => ({}) }));
vi.mock('../../ai', () => ({
  defaultLlm: { complete: vi.fn() },
  parseLlmJson: vi.fn(),
  DEFAULT_GEMINI_MODEL: 'test-model',
  SchemaType: {},
}));
vi.mock('../structured-output', () => ({ structureResolutionResponseSchema: () => ({}) }));
// config validates the environment at import; stub the Drive read timeouts
// so the client loads without one.
vi.mock('../../config', () => ({
  config: { DRIVE_READ_TIMEOUT_MS: 60_000, DRIVE_MEDIA_TIMEOUT_MS: 300_000 },
}));

const { gatherFolders } = await import('../structure');
const { gatherFilesAuto, gatherFilesRecursive } = await import('../../backfill/discovery');
const { listSubtreeFiles } = await import('../subtree');
const {
  FlatListingUnavailableError,
  isListingUnavailableError,
  listAllFoldersInDrive,
  listFolderChildren,
  listingFailureCause,
  listSharedDriveFiles,
  listSubfolders,
} = await import('../client');
const { setLogCapture } = await import('../../scan/output');

const DRIVE = 'drive';
const ROOT = 'R';
const LABEL = 'Client A';

// The same synthetic tree as folder-tree.test.ts, now with files:
//   drive / Archive / Client A (root) / {2026 / {Launch, Assets}, Admin}
//   drive / Other client / Stuff — outside the root
function buildClientTree(): FakeItem[] {
  return [
    folder('arch', 'Archive', DRIVE),
    folder(ROOT, LABEL, 'arch'),
    folder('y26', '2026', ROOT),
    folder('launch', 'Launch', 'y26'),
    folder('assets', 'Assets', 'y26'),
    folder('admin', 'Admin', ROOT),
    folder('other', 'Other client', DRIVE),
    folder('stuff', 'Stuff', 'other'),
    file('f-brief', 'brief.pdf', 'launch'),
    file('f-logo', 'logo.png', 'assets', { mimeType: 'image/png' }),
    file('f-contacts', 'contacts.pdf', 'admin'),
    file('f-overview', 'overview.pdf', ROOT),
    file('f-link', 'deck link', 'y26', {
      mimeType: 'application/vnd.google-apps.shortcut',
      shortcutDetails: { targetId: 'elsewhere', targetMimeType: 'application/pdf' },
    }),
    // A trashed folder: Drive marks its children trashed too.
    { ...folder('bin', 'Old', ROOT), trashed: true },
    { ...file('f-old', 'old.pdf', 'bin'), trashed: true },
    // Outside the root, and an orphan whose parent is not visible.
    file('f-other', 'other.pdf', 'stuff'),
    file('f-top', 'top.pdf', DRIVE),
    file('f-orphan', 'orphan.pdf', 'ghost'),
  ];
}

// Built once: the file builder stamps increasing times, and the walk and the
// flat listing must read identical items.
const CLIENT_TREE = buildClientTree();
const clientTree = (): FakeItem[] => CLIENT_TREE;

/**
 * The ids of `root` and everything under it: what a listing that does not
 * show the bot this part of the drive leaves out.
 */
function subtreeIds(items: FakeItem[], root: string): string[] {
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of items) {
      if (!out.has(i.id) && i.parents?.some((p) => out.has(p))) {
        out.add(i.id);
        grew = true;
      }
    }
  }
  return [...out];
}

/** `count` folders spread over a tree under `parent`, ids prefixed. */
function manyFolders(prefix: string, parent: string, count: number): FakeItem[] {
  const out: FakeItem[] = [];
  for (let i = 0; i < count; i++) {
    // Each folder hangs off an earlier one (or the parent): a deep, bushy tree.
    const p = i === 0 ? parent : `${prefix}${Math.floor((i - 1) / 3)}`;
    out.push(folder(`${prefix}${i}`, `F${i}`, p));
  }
  return out;
}

// The client paces calls 250 ms apart off Date.now; a clock that jumps a
// second per read keeps the pacing logic live without real waits. It is
// monotonic across tests: the limiter is a module singleton that remembers
// its last call, so a clock reset per test would make it sleep for real.
let clock = Date.now();
let logLines: string[];
beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  logLines = [];
  setLogCapture(logLines);
});
afterEach(() => {
  setLogCapture(null);
  vi.restoreAllMocks();
});

/** The same items as a My Drive tree: no driveId, so every gather recurses. */
const asMyDrive = (items: FakeItem[]) => resetFakeDrive({ driveId: null, items });
const asSharedDrive = (
  items: FakeItem[],
  extra: {
    refuseDriveListing?: unknown;
    refuseFileListing?: unknown;
    hiddenFromDriveListing?: string[];
  } = {},
) => resetFakeDrive({ driveId: DRIVE, items, ...extra });

// Errors that are NOT a refusal: no fallback, the error reaches the caller.
const badRequest = () => Object.assign(new Error('bad request'), { code: 400 });
const dailyLimit = () =>
  Object.assign(new Error('daily limit'), {
    code: 403,
    errors: [{ reason: 'dailyLimitExceeded' }],
  });

describe('page size', () => {
  it('every files.list call asks for 1000 items', async () => {
    asSharedDrive(clientTree());
    await listFolderChildren(ROOT);
    await listSubfolders(ROOT);
    await listAllFoldersInDrive(DRIVE);
    await listSharedDriveFiles(DRIVE);
    const sizes = listCalls().map((c) => c.params['pageSize']);
    expect(sizes).toHaveLength(4);
    expect(new Set(sizes)).toEqual(new Set([1000]));
  });
});

describe('gatherFolders', () => {
  it('a folder inside a shared drive gets the same tree as the recursive walk', async () => {
    asMyDrive(clientTree());
    const walked = await gatherFolders(ROOT, LABEL);
    asSharedDrive(clientTree());
    const flat = await gatherFolders(ROOT, LABEL);
    expect(flat).toEqual(walked);
    expect(flat.map((n) => n.path)).toEqual([
      'Client A / 2026',
      'Client A / 2026 / Launch',
      'Client A / 2026 / Assets',
      'Client A / Admin',
    ]);
  });

  it('a folder inside a shared drive costs ceil(drive folders / 1000) calls, not one per folder', async () => {
    // 2,345 folders in the drive; 600 of them under the root.
    const items = [
      folder('arch', 'Archive', DRIVE),
      folder(ROOT, LABEL, 'arch'),
      ...manyFolders('in', ROOT, 600),
      ...manyFolders('out', DRIVE, 2345 - 602),
    ];
    asMyDrive(items);
    const walked = await gatherFolders(ROOT, LABEL);
    const walkCalls = listCalls().length;

    asSharedDrive(items);
    const flat = await gatherFolders(ROOT, LABEL);
    const flatCalls = listCalls();

    expect(flat).toEqual(walked);
    expect(flat).toHaveLength(600);
    expect(walkCalls).toBe(601); // the root plus one per subtree folder
    expect(flatCalls).toHaveLength(Math.ceil(2345 / 1000));
    expect(flatCalls.every((c) => c.params['corpora'] === 'drive')).toBe(true);
  });

  it('the forward sweep of a drive root drops from 34 pages to 7', async () => {
    asSharedDrive(manyFolders('f', DRIVE, 6753));
    const folders = await gatherFolders(DRIVE, 'Drive');
    expect(folders).toHaveLength(6753);
    expect(listCalls()).toHaveLength(7); // ceil(6753 / 200) = 34 before
  });

  it('falls back to the walk when the drive listing is refused', async () => {
    const refusal = Object.assign(new Error('membership required'), {
      code: 403,
      errors: [{ reason: 'teamDriveMembershipRequired' }],
    });
    asMyDrive(clientTree());
    const walked = await gatherFolders(ROOT, LABEL);
    asSharedDrive(clientTree(), { refuseDriveListing: refusal });
    expect(await gatherFolders(ROOT, LABEL)).toEqual(walked);
  });

  it('falls back to the walk when the listing leaves the root’s subtree out', async () => {
    asMyDrive(clientTree());
    const walked = await gatherFolders(ROOT, LABEL);
    asSharedDrive(clientTree(), { hiddenFromDriveListing: subtreeIds(clientTree(), ROOT) });
    expect(await gatherFolders(ROOT, LABEL)).toEqual(walked);
    expect(walked).toHaveLength(4);
  });

  it('a limit or any other non-refusal error propagates, with no fallback', async () => {
    for (const err of [badRequest(), dailyLimit()]) {
      asSharedDrive(clientTree(), { refuseDriveListing: err });
      await expect(gatherFolders(ROOT, LABEL)).rejects.toBe(err);
      expect(listCalls().every((c) => c.params['corpora'] === 'drive')).toBe(true);
    }
  });

  it('the drive root has no fallback: a refusal propagates', async () => {
    const refusal = Object.assign(new Error('not found'), { code: 404 });
    asSharedDrive(clientTree(), { refuseDriveListing: refusal });
    await expect(gatherFolders(DRIVE, 'Drive')).rejects.toBe(refusal);
  });
});

describe('gatherFilesAuto', () => {
  const strip = ({ version: _v, md5Checksum: _m, ...rest }: Record<string, unknown>) => rest;

  it('a folder inside a shared drive yields exactly what the walk yields, in the same order', async () => {
    asMyDrive(clientTree());
    const walked = await gatherFilesRecursive(ROOT, LABEL, false);
    asSharedDrive(clientTree());
    const flat = await gatherFilesAuto(ROOT, LABEL, false);

    expect(flat.map(strip)).toEqual(walked.map(strip));
    expect(flat.map((f) => f.path)).toEqual([
      'Client A / 2026 / Launch / brief.pdf',
      'Client A / 2026 / Assets / logo.png',
      'Client A / Admin / contacts.pdf',
      'Client A / overview.pdf',
      'Client A / 2026 / deck link',
    ]);
    // The flat listing alone carries the content markers.
    expect(flat[0]).toMatchObject({ version: expect.any(String), md5Checksum: 'md5-f-brief' });
    expect(flat[4]?.shortcutTarget).toEqual({ id: 'elsewhere', mimeType: 'application/pdf' });
  });

  it('logs the flat path and its parent-map counters', async () => {
    asSharedDrive(clientTree());
    await gatherFilesAuto(ROOT, LABEL, false);
    expect(logLines).toEqual([
      `  Folder type: folder inside drive (driveId=${DRIVE})`,
      '  Using FLAT list of the drive, cut to this folder…',
      // 5 kept; other.pdf + top.pdf reach the drive root; orphan.pdf's parent is not
      // visible; old.pdf is trashed, so the listing never returns it.
      '  Parent map (files): in_scope=5 out_of_scope=2 orphans=1 multi_parent=0 depth_cap=0',
    ]);
  });

  it('costs ceil(folders / 1000) + ceil(files / 1000) calls, not one per folder', async () => {
    const folders = [folder(ROOT, LABEL, DRIVE), ...manyFolders('in', ROOT, 1500)];
    const files = folders.flatMap((f, i) =>
      i % 2 === 0 ? [file(`x${i}`, `doc${i}.pdf`, f.id)] : [],
    );
    const items = [...folders, ...files, ...manyFolders('out', DRIVE, 999)];
    asMyDrive(items);
    const walked = await gatherFilesRecursive(ROOT, LABEL, true);
    const walkCalls = listCalls().length;

    asSharedDrive(items);
    const flat = await gatherFilesAuto(ROOT, LABEL, true);
    // 2,500 folders + 751 files in the drive.
    expect(listCalls()).toHaveLength(Math.ceil(2500 / 1000) + Math.ceil(751 / 1000));
    expect(walkCalls).toBe(1501);
    expect(flat.map(strip)).toEqual(walked.map(strip));
  });

  it('depth cap: files beneath the cap are not listed, as in the walk', async () => {
    const items: FakeItem[] = [folder(ROOT, LABEL, DRIVE)];
    for (let i = 1; i <= 103; i++) {
      items.push(folder(`d${i}`, `L${i}`, i === 1 ? ROOT : `d${i - 1}`));
      items.push(file(`fd${i}`, `at-${i}.pdf`, `d${i}`));
    }
    asMyDrive(items);
    const walked = await gatherFilesRecursive(ROOT, LABEL, false);
    const walkLines = [...logLines];
    logLines.length = 0;
    asSharedDrive(items);
    const flat = await gatherFilesAuto(ROOT, LABEL, false);

    expect(flat.map(strip)).toEqual(walked.map(strip));
    expect(flat).toHaveLength(100); // files in folders at depth 1..100
    const capLine = '  ⚠ 1 subfolder(s) past depth cap — files beneath NOT listed';
    expect(walkLines).toContain(capLine);
    expect(logLines).toContain(capLine);
    expect(logLines).toContain(
      '  Parent map (files): in_scope=100 out_of_scope=0 orphans=0 multi_parent=0 depth_cap=1',
    );
  });

  it('falls back to the walk when the drive listing is refused', async () => {
    const refusal = Object.assign(new Error('not found'), { code: 404 });
    asMyDrive(clientTree());
    const walked = await gatherFilesRecursive(ROOT, LABEL, false);
    logLines.length = 0;
    asSharedDrive(clientTree(), { refuseDriveListing: refusal });
    const files = await gatherFilesAuto(ROOT, LABEL, false);
    expect(files).toEqual(walked);
    expect(logLines.slice(-2)).toEqual([
      '  ⚠ flat listing unavailable (HTTP 404) — falling back to the recursive walk',
      '  Using RECURSIVE walk…',
    ]);
  });

  it('falls back when the file sweep alone is refused, or the root is left out', async () => {
    asMyDrive(clientTree());
    const walked = await gatherFilesRecursive(ROOT, LABEL, false);
    const refusal = Object.assign(new Error('forbidden'), {
      code: 403,
      errors: [{ reason: 'insufficientFilePermissions' }],
    });
    const hidden = { hiddenFromDriveListing: subtreeIds(clientTree(), ROOT) };
    for (const extra of [{ refuseFileListing: refusal }, hidden]) {
      logLines.length = 0;
      asSharedDrive(clientTree(), extra);
      expect(await gatherFilesAuto(ROOT, LABEL, false)).toEqual(walked);
      expect(logLines).toContain('  Using RECURSIVE walk…');
    }
    expect(logLines).toContain(
      '  ⚠ flat listing unavailable (root not in the drive listing) — falling back to the recursive walk',
    );
  });

  it('a limit or any other non-refusal error propagates, with no fallback', async () => {
    for (const err of [badRequest(), dailyLimit()]) {
      asSharedDrive(clientTree(), { refuseFileListing: err });
      await expect(gatherFilesAuto(ROOT, LABEL, false)).rejects.toBe(err);
    }
  });

  it('the file sweep orders by createdTime and keeps an id listed twice once', async () => {
    const items = clientTree();
    const dup = items.find((i) => i.id === 'f-brief')!;
    asSharedDrive([...items, dup]);
    const files = await gatherFilesAuto(ROOT, LABEL, false);
    expect(files.filter((f) => f.id === 'f-brief')).toHaveLength(1);
    const fileSweep = listCalls().filter((c) => String(c.params['q']).includes('!='));
    expect(fileSweep.map((c) => c.params['orderBy'])).toEqual(['createdTime']);
  });

  it('a file with no createdTime sorts first; a file with no parents is an orphan', async () => {
    const items = [
      ...clientTree(),
      { ...file('f-undated', 'undated.pdf', 'admin'), createdTime: undefined },
      { ...file('f-parentless', 'parentless.pdf', 'admin'), parents: undefined },
    ] as FakeItem[];
    asMyDrive(items);
    const walked = await gatherFilesRecursive(ROOT, LABEL, false);
    logLines.length = 0;
    asSharedDrive(items);
    const flat = await gatherFilesAuto(ROOT, LABEL, false);
    expect(flat.map(strip)).toEqual(walked.map(strip));
    expect(flat[0]?.id).toBe('f-undated');
    expect(flat.map((f) => f.id)).not.toContain('f-parentless');
    expect(logLines).toContain(
      '  Parent map (files): in_scope=6 out_of_scope=2 orphans=2 multi_parent=0 depth_cap=0',
    );
  });

  it('files with the very same createdTime: same set, createdTime order kept', async () => {
    const at = '2026-03-01T00:00:00.000Z';
    const items: FakeItem[] = [
      folder(ROOT, LABEL, DRIVE),
      folder('a', 'A', ROOT),
      folder('b', 'B', ROOT),
      file('t1', 't1.pdf', 'b', { createdTime: at }),
      file('t2', 't2.pdf', 'a', { createdTime: at }),
      file('t3', 't3.pdf', ROOT, { createdTime: '2026-02-01T00:00:00.000Z' }),
      file('t4', 't4.pdf', 'a', { createdTime: at }),
    ];
    asMyDrive(items);
    const walked = await gatherFilesRecursive(ROOT, LABEL, false);
    asSharedDrive(items);
    const flat = await gatherFilesAuto(ROOT, LABEL, false);
    const ids = (fs: { id: string }[]) => fs.map((f) => f.id);
    expect(ids(flat)[0]).toBe('t3');
    expect(ids(walked)[0]).toBe('t3');
    expect(new Set(ids(flat))).toEqual(new Set(ids(walked)));
    // Tie order is listing order on each path; it may differ between them.
  });

  it('the drive root keeps its flat list with path = name', async () => {
    asSharedDrive(clientTree());
    const files = await gatherFilesAuto(DRIVE, 'Drive', false);
    const brief = files.find((f) => f.id === 'f-brief');
    expect(brief?.path).toBe('brief.pdf');
    // Every listing now carries Drive's content markers (FILE_FIELDS), not
    // only the flat subtree listing: the unchanged-content gate reads them.
    expect(brief).toHaveProperty('version', '11');
    expect(files.map((f) => f.id)).toContain('f-orphan'); // no subtree filter there
  });

  it('My Drive roots still walk', async () => {
    asMyDrive(clientTree());
    await gatherFilesAuto(ROOT, LABEL, false);
    expect(logLines).toContain('  Using RECURSIVE walk…');
    expect(listCalls().some((c) => c.params['corpora'] === 'drive')).toBe(false);
  });
});

describe('listSubtreeFiles', () => {
  it('returns the subtree’s folders, the root excluded, as gatherFolders builds them', async () => {
    asSharedDrive(clientTree());
    const { files, folders, folderCount } = await listSubtreeFiles(ROOT, LABEL, DRIVE);

    // The tree the file paths were cut from: the index catch-up walks parentId
    // up it to find the campaign folder that owns a file.
    expect(folders).toEqual(await gatherFolders(ROOT, LABEL));
    expect(folders.map((n) => [n.id, n.parentId])).toEqual([
      ['y26', null],
      ['launch', 'y26'],
      ['assets', 'y26'],
      ['admin', null],
    ]);
    expect(folderCount).toBe(folders.length);
    expect(files).toHaveLength(5);
  });
});

describe('isListingUnavailableError', () => {
  it('a 404, or a 403 that is not a rate limit, is a refusal', () => {
    expect(isListingUnavailableError({ code: 404 })).toBe(true);
    expect(isListingUnavailableError({ status: 404 })).toBe(true);
    expect(
      isListingUnavailableError({ code: 403, errors: [{ reason: 'insufficientFilePermissions' }] }),
    ).toBe(true);
  });

  it('a listing without the root, and a 403 with no reason, are refusals', () => {
    expect(isListingUnavailableError(new FlatListingUnavailableError('x'))).toBe(true);
    expect(isListingUnavailableError({ code: 403 })).toBe(true);
    expect(
      isListingUnavailableError({
        code: 403,
        response: { data: { error: { errors: [{ reason: 'teamDriveMembershipRequired' }] } } },
      }),
    ).toBe(true);
  });

  it('a 403 naming any limit or quota is not', () => {
    for (const reason of [
      'userRateLimitExceeded',
      'rateLimitExceeded',
      'dailyLimitExceeded',
      'sharingRateLimitExceeded',
      'quotaExceeded',
    ]) {
      expect(isListingUnavailableError({ code: 403, errors: [{ reason }] })).toBe(false);
    }
  });

  it('describes the cause with status and reasons only', () => {
    expect(listingFailureCause({ code: 404 })).toBe('HTTP 404');
    expect(listingFailureCause({ code: 403, errors: [{ reason: 'forbidden' }] })).toBe(
      'HTTP 403 forbidden',
    );
    expect(listingFailureCause(new FlatListingUnavailableError('x'))).toBe(
      'root not in the drive listing',
    );
  });

  it('a rate limit, a 5xx or a transport fault is not', () => {
    expect(
      isListingUnavailableError({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }] }),
    ).toBe(false);
    expect(isListingUnavailableError({ code: 500 })).toBe(false);
    expect(isListingUnavailableError({ code: 'ECONNRESET' })).toBe(false);
    expect(isListingUnavailableError(null)).toBe(false);
  });
});
