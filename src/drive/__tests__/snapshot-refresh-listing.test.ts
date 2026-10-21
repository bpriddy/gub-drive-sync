import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDriveApi, file, folder, listCalls, resetFakeDrive, type FakeItem } from './fake-drive';

// The catch-up over the REAL client, flat listing and walk, on a fake Drive:
// only googleapis (the fake), the bot credential lookup (DB), the logger and
// Prisma are stubbed. What the mocked-listing tests in snapshot-refresh.test.ts
// cannot show: that flat and walked listings plan the same rows, and what each
// costs in files.list calls.
vi.mock('googleapis', () => ({ google: { drive: () => fakeDriveApi } }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: async () => ({}) }));
// config validates the environment at import; stub the Drive read timeouts so
// the client loads without one.
vi.mock('../../config', () => ({
  config: { DRIVE_READ_TIMEOUT_MS: 60_000, DRIVE_MEDIA_TIMEOUT_MS: 300_000 },
}));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = vi.hoisted(() => ({
  root: 'R',
  created: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../prisma', () => ({
  prisma: {
    account: {
      findMany: vi.fn(async () => [{ id: 'acct-1', name: 'Acme', driveFolderId: db.root }]),
    },
    campaign: { findMany: vi.fn(async () => [{ id: 'camp-launch', driveFolderId: 'launch' }]) },
    // The asset folder is a piece of the same campaign.
    campaignPiece: {
      findMany: vi.fn(async () => [{ campaignId: 'camp-launch', driveFolderId: 'assets' }]),
    },
    // Nothing indexed yet: every listed file is "unindexed".
    $queryRaw: vi.fn(async () => []),
    driveFileSnapshot: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.created.push(data);
        return data;
      }),
    },
  },
}));

const { refreshFileSnapshots } = await import('../snapshot-refresh');
const { setLogCapture } = await import('../../scan/output');

const DRIVE = 'drive';
const ROOT = 'R';

// drive / Archive / Acme (root) / {2026 / {Launch / Decks, Assets}, Admin}
// drive / Other client / Stuff — outside the root
function acmeTree(): FakeItem[] {
  return [
    folder('arch', 'Archive', DRIVE),
    folder(ROOT, 'Acme', 'arch'),
    folder('y26', '2026', ROOT),
    folder('launch', 'Launch', 'y26'),
    folder('decks', 'Decks', 'launch'),
    folder('assets', 'Assets', 'y26'),
    folder('admin', 'Admin', ROOT),
    folder('other', 'Other client', DRIVE),
    folder('stuff', 'Stuff', 'other'),
    file('f-brief', 'brief.pdf', 'launch'),
    file('f-pitch', 'pitch.pdf', 'decks'),
    file('f-logo', 'logo.png', 'assets', { mimeType: 'image/png' }),
    file('f-contacts', 'contacts.pdf', 'admin'),
    file('f-overview', 'overview.pdf', ROOT),
    file('f-elsewhere', 'elsewhere.pdf', 'stuff'),
  ];
}
// Built once: the file builder stamps increasing times, and the walk and the
// flat listing must read identical items.
const ACME = acmeTree();

const asMyDrive = (items: FakeItem[]) => resetFakeDrive({ driveId: null, items });
const asSharedDrive = (items: FakeItem[], extra: { refuseDriveListing?: unknown } = {}) =>
  resetFakeDrive({ driveId: DRIVE, items, ...extra });

const byFile = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  String(a['fileId']).localeCompare(String(b['fileId']));
const plan = () =>
  [...db.created].sort(byFile).map((r) => [r['fileId'], r['path'], r['campaignId']]);

let clock = Date.now();
beforeEach(() => {
  // The client paces calls 250 ms apart off Date.now; a clock that jumps a
  // second per read keeps the pacing logic live without real waits. It is
  // monotonic across tests: the limiter is a module singleton.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  setLogCapture([]);
  db.root = ROOT;
  db.created = [];
});
afterEach(() => {
  setLogCapture(null);
  vi.restoreAllMocks();
});

describe('refreshFileSnapshots over a fake Drive', () => {
  it('plans the same rows from the flat listing and from the walk: account-rooted paths, folder attribution', async () => {
    asMyDrive(ACME);
    await refreshFileSnapshots({ confirm: true });
    const walked = plan();

    db.created = [];
    asSharedDrive(ACME);
    await refreshFileSnapshots({ confirm: true });
    const flat = plan();

    expect(flat).toEqual(walked);
    expect(flat).toEqual([
      // A piece folder (Assets) and a campaign folder (Launch, and below it Decks) both own their files.
      ['f-brief', 'Acme / 2026 / Launch / brief.pdf', 'camp-launch'],
      ['f-contacts', 'Acme / Admin / contacts.pdf', null],
      ['f-logo', 'Acme / 2026 / Assets / logo.png', 'camp-launch'],
      ['f-overview', 'Acme / overview.pdf', null],
      ['f-pitch', 'Acme / 2026 / Launch / Decks / pitch.pdf', 'camp-launch'],
    ]);
  });

  it('a refused drive listing falls back to the walk and plans the same rows', async () => {
    const refusal = Object.assign(new Error('not found'), { code: 404 });
    asSharedDrive(ACME, { refuseDriveListing: refusal });
    const lines: string[] = [];
    setLogCapture(lines);

    const res = await refreshFileSnapshots({ confirm: true });

    expect(res.rowsWritten).toBe(5);
    expect(lines.join('\n')).toContain('flat listing unavailable (HTTP 404)');
    expect(plan().map(([id]) => id)).toEqual([
      'f-brief',
      'f-contacts',
      'f-logo',
      'f-overview',
      'f-pitch',
    ]);
  });

  it('lists the drive root flat, with breadcrumbs from the account name', async () => {
    db.root = DRIVE;
    asSharedDrive([
      folder('launch', 'Launch', DRIVE),
      file('f-brief', 'brief.pdf', 'launch'),
      file('f-top', 'top.pdf', DRIVE),
    ]);

    await refreshFileSnapshots({ confirm: true });

    // listSharedDriveFiles would have left the bare file names as paths.
    expect(plan()).toEqual([
      ['f-brief', 'Acme / Launch / brief.pdf', 'camp-launch'],
      ['f-top', 'Acme / top.pdf', null],
    ]);
  });

  it('costs ceil(items / 1000) list calls, not one per folder', async () => {
    // 1,200 folders under the root, a file in every other one, and 999 more
    // folders elsewhere in the drive.
    const many: FakeItem[] = [folder(ROOT, 'Acme', DRIVE)];
    for (let i = 0; i < 1200; i++) {
      many.push(folder(`in${i}`, `F${i}`, i === 0 ? ROOT : `in${Math.floor((i - 1) / 3)}`));
      if (i % 2 === 0) many.push(file(`x${i}`, `doc${i}.pdf`, `in${i}`));
    }
    for (let i = 0; i < 999; i++) many.push(folder(`out${i}`, `O${i}`, DRIVE));

    asMyDrive(many);
    await refreshFileSnapshots({});
    const walkCalls = listCalls().length;

    asSharedDrive(many);
    const res = await refreshFileSnapshots({});

    // 2,200 folders, then 600 files.
    expect(listCalls()).toHaveLength(Math.ceil(2200 / 1000) + Math.ceil(600 / 1000));
    expect(walkCalls).toBeGreaterThan(1200);
    expect(res.filesSeen).toBe(600);
    expect(res.rowsPlanned).toBe(600);
  });
});
