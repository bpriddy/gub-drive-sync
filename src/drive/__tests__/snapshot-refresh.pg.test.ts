/**
 * The Drive name index catch-up (refresh-snapshots) against a real Postgres
 * with the REAL schema: the latest-row and same-run lookups, the writer and
 * checkDelta all run for real. Only the Drive listing is mocked.
 *
 * Why this exists: the v1 sync left two rows per file inside a campaign — one
 * rooted at the account, a later one rooted at the campaign — and the
 * comparison has to read the right one. That is SQL (DISTINCT ON, a join on
 * unnest, uuid casts), and mocked Prisma cannot tell a working query from a
 * broken one. The `sync_runs` row below is the real foreign key a v1 row
 * carries.
 *
 * Skipped unless H4_PG_URL points at a disposable database. Set it up with
 * GUB's migration chain, NOT `prisma db push` from the gub-schemas schema:
 * that schema declares no relation on drive_file_snapshots.sync_run_id, so a
 * push would drop exactly the foreign key v1 rows depend on.
 *
 *   docker run --rm -d --name h4-catchup-pg -p 55454:5432 -e POSTGRES_PASSWORD=password pgvector/pgvector:pg16
 *   mkdir -p /tmp/gub-prisma && git -C <gcp-universal-backend checkout> archive origin/main prisma | tar -x -C /tmp/gub-prisma
 *   DATABASE_URL=postgresql://postgres:password@localhost:55454/postgres \
 *     npx prisma migrate deploy --schema /tmp/gub-prisma/prisma/schema.prisma
 *   H4_PG_URL=postgresql://postgres:password@localhost:55454/postgres npx vitest run snapshot-refresh.pg
 *
 * NEVER point it at a shared database: it deletes the drive_file_snapshots
 * rows of its own test account (and briefly adds a CHECK constraint; the guard
 * in beforeAll only lets a database on this machine, named like a scratch one,
 * through). The other pg file, snapshot-index.pg.test.ts, cleans only its own
 * account too, so the two can share the database and run in parallel.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PG_URL = vi.hoisted(() => {
  const url = process.env['H4_PG_URL'];
  if (url) process.env['DATABASE_URL'] = url;
  else process.env['DATABASE_URL'] ??= 'postgres://skipped/skipped';
  return url;
});

const m = vi.hoisted(() => ({
  listing: { files: [] as unknown[], folders: [] as unknown[] },
  warn: vi.fn(),
  lines: [] as string[],
}));

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: m.warn, error: vi.fn() },
}));
// The Drive edge: the account's tree comes from the fixture, flat or walked.
vi.mock('../client', () => ({
  probeFolder: vi.fn(async () => ({
    isSharedDriveRoot: false,
    driveId: 'drive-1',
    mimeType: null,
  })),
  isListingUnavailableError: () => false,
  listingFailureCause: () => 'HTTP 404',
}));
vi.mock('../subtree', () => ({
  listSubtreeFiles: vi.fn(async () => ({
    files: m.listing.files,
    folders: m.listing.folders,
    folderCount: m.listing.folders.length,
    depthCapHits: 0,
    stats: {},
  })),
}));
vi.mock('../traversal', () => ({
  traverseFolder: async function* () {
    for (const e of [...m.listing.folders, ...m.listing.files]) yield e;
  },
}));

import { prisma } from '../../prisma';
import { setLogCapture } from '../../scan/output';
import { checkDelta } from '../snapshot';
import { refreshFileSnapshots } from '../snapshot-refresh';
import type { TraversedFile } from '../types';

const STAFF_ID = '00000000-0000-4000-a000-0000000000d1';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000000d2';
const CAMPAIGN_ID = '00000000-0000-4000-a000-0000000000d3';
// The older run sorts AFTER the newer one, so picking a row by run order would pick wrong.
const RUN_A = '00000000-0000-4000-a000-0000000000d5'; // the older v1 run
const RUN_B = '00000000-0000-4000-a000-0000000000d4'; // the newer one
const ROOT = 'folder-root';
const CAMPAIGN_FOLDER = 'folder-q3';
const WRITE_FAILED = '[drive.snapshot] write failed';

const M0 = new Date('2026-08-01T00:00:00.000Z'); // the version v1 indexed
const M1 = new Date('2026-09-15T00:00:00.000Z'); // a newer one

function listed(
  id: string,
  name: string,
  where: { parent?: string; dir?: string; modified?: Date } = {},
): TraversedFile {
  const parent = where.parent ?? ROOT;
  const dir = where.dir ?? (parent === ROOT ? 'Acme' : 'Acme / Q3 Launch');
  return {
    id,
    name,
    mimeType: 'application/pdf',
    parents: [parent],
    path: `${dir} / ${name}`,
    modifiedTime: (where.modified ?? M0).toISOString(),
    modifiedByEmail: null,
    createdTime: null,
    size: null,
    isFolder: false,
  };
}

/** One row as v1 (a run id) or v2 (none) would have written it. */
function seed(row: {
  fileId: string;
  name: string;
  path: string;
  syncRunId?: string;
  campaign?: boolean;
  scannedAt: string;
  modified?: Date;
  skipReason?: string;
  wasExtracted?: boolean;
}) {
  return prisma.driveFileSnapshot.create({
    data: {
      fileId: row.fileId,
      name: row.name,
      path: row.path,
      mimeType: 'application/pdf',
      modifiedTime: row.modified ?? M0,
      syncRunId: row.syncRunId ?? null,
      accountId: ACCOUNT_ID,
      campaignId: row.campaign ? CAMPAIGN_ID : null,
      wasExtracted: row.wasExtracted ?? false,
      skipReason: row.skipReason ?? null,
      scannedAt: new Date(row.scannedAt),
    },
  });
}

/** What v1 wrote for a file inside the campaign folder: the account scan, then the campaign scan. */
async function seedV1Pair(
  fileId: string,
  name: string,
  run: string,
  accountPath: string,
  at: string,
): Promise<void> {
  await seed({ fileId, name, path: accountPath, syncRunId: run, scannedAt: `${at}:00Z` });
  await seed({
    fileId,
    name,
    path: `Q3 Launch / ${name}`,
    syncRunId: run,
    campaign: true,
    scannedAt: `${at}:30Z`,
  });
}

const rowsOf = (fileId: string) =>
  prisma.driveFileSnapshot.findMany({ where: { fileId }, orderBy: { scannedAt: 'asc' } });
const allRows = () => prisma.driveFileSnapshot.count({ where: { accountId: ACCOUNT_ID } });
/** What GUB's file search reads: the latest row per file. */
const searchView = async () =>
  Object.fromEntries(
    (
      await prisma.$queryRaw<Array<{ fileId: string; name: string; path: string }>>`
        SELECT DISTINCT ON (file_id) file_id AS "fileId", name, path
          FROM drive_file_snapshots WHERE account_id = ${ACCOUNT_ID}::uuid
         ORDER BY file_id, scanned_at DESC`
    ).map((r) => [r.fileId, r]),
  );

describe.skipIf(!PG_URL)('Drive name index catch-up against Postgres (real schema)', () => {
  beforeAll(async () => {
    const url = new URL(PG_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error(
        `H4_PG_URL points at "${url.hostname}" — use a throwaway database on this machine`,
      );
    }
    const db = url.pathname.slice(1);
    if (!/^(postgres|.*(test|scratch|throwaway|tmp).*)$/i.test(db)) {
      throw new Error(`H4_PG_URL names database "${db}" — point it at a throwaway database`);
    }
    await prisma.$executeRawUnsafe(
      `ALTER TABLE drive_file_snapshots DROP CONSTRAINT IF EXISTS h4_catchup_poison_file`,
    );
    await prisma.staff.upsert({
      where: { id: STAFF_ID },
      create: {
        id: STAFF_ID,
        fullName: 'Catch-up Test',
        email: 'catchup-test@example.com',
        startedAt: new Date('2026-01-01'),
      },
      update: {},
    });
    await prisma.account.upsert({
      where: { id: ACCOUNT_ID },
      create: { id: ACCOUNT_ID, name: 'Acme', driveFolderId: ROOT },
      update: {},
    });
    await prisma.campaign.upsert({
      where: { id: CAMPAIGN_ID },
      create: {
        id: CAMPAIGN_ID,
        accountId: ACCOUNT_ID,
        name: 'Q3 Launch',
        driveFolderId: CAMPAIGN_FOLDER,
        createdBy: STAFF_ID,
      },
      update: {},
    });
    // The v1 runs the legacy rows point at: the real foreign key.
    for (const id of [RUN_A, RUN_B]) {
      await prisma.syncRun.upsert({
        where: { id },
        create: { id, source: 'google_drive', status: 'success' },
        update: {},
      });
    }
  });

  beforeEach(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    m.warn.mockClear();
    m.lines = [];
    setLogCapture(m.lines);
    await prisma.driveFileSnapshot.deleteMany({ where: { accountId: ACCOUNT_ID } });
  });

  afterAll(async () => {
    setLogCapture(null);
    vi.restoreAllMocks();
    await prisma.$disconnect();
  });

  describe('refreshFileSnapshots', () => {
    /**
     * The state of an index that stopped at the last v1 run, and what Drive
     * lists now. Eight files, each a different case.
     */
    async function seedIndexAndListing(): Promise<void> {
      // Unchanged since v1: its campaign-rooted row must not read as a move.
      await seedV1Pair(
        'f-legacy-same',
        'Legacy Same.pdf',
        RUN_B,
        'Acme / Q3 Launch / Legacy Same.pdf',
        '2026-08-13T10:00',
      );
      // The campaign folder sat elsewhere when v1 ran: a real move.
      await seedV1Pair(
        'f-legacy-moved',
        'Legacy Moved.pdf',
        RUN_B,
        'Acme / Old Place / Legacy Moved.pdf',
        '2026-08-13T10:00',
      );
      // Only the campaign scan's row survives: nothing to normalize with.
      await seed({
        fileId: 'f-legacy-nosib',
        name: 'Legacy NoSib.pdf',
        path: 'Q3 Launch / Legacy NoSib.pdf',
        syncRunId: RUN_B,
        campaign: true,
        scannedAt: '2026-08-13T10:00:30Z',
      });
      // Two v1 runs: the older run's account row has the OLD path, the newer
      // run's the current one. The latest row belongs to the newer run.
      await seedV1Pair(
        'f-two-runs',
        'Two Runs.pdf',
        RUN_A,
        'Acme / Old Place / Two Runs.pdf',
        '2026-08-01T10:00',
      );
      await seedV1Pair(
        'f-two-runs',
        'Two Runs.pdf',
        RUN_B,
        'Acme / Q3 Launch / Two Runs.pdf',
        '2026-08-13T10:00',
      );
      // Account-level, renamed since.
      await seed({
        fileId: 'f-renamed',
        name: 'Old Deck.pdf',
        path: 'Acme / Old Deck.pdf',
        syncRunId: RUN_B,
        scannedAt: '2026-08-13T10:00:00Z',
      });
      // Written by the scan core: same path, same version.
      await seed({
        fileId: 'f-v2-same',
        name: 'V2 Same.pdf',
        path: 'Acme / Q3 Launch / V2 Same.pdf',
        campaign: true,
        wasExtracted: true,
        scannedAt: '2026-10-01T10:00:00Z',
      });
      // Edited since it was indexed.
      await seed({
        fileId: 'f-modified',
        name: 'Modified.pdf',
        path: 'Acme / Modified.pdf',
        scannedAt: '2026-10-01T10:00:00Z',
      });

      m.listing.folders = [
        {
          ...listed(CAMPAIGN_FOLDER, 'Q3 Launch', { dir: 'Acme' }),
          mimeType: 'application/vnd.google-apps.folder',
          isFolder: true,
          parentId: null,
          depth: 1,
        },
      ];
      m.listing.files = [
        listed('f-legacy-same', 'Legacy Same.pdf', { parent: CAMPAIGN_FOLDER }),
        listed('f-legacy-moved', 'Legacy Moved.pdf', { parent: CAMPAIGN_FOLDER }),
        listed('f-legacy-nosib', 'Legacy NoSib.pdf', { parent: CAMPAIGN_FOLDER }),
        listed('f-two-runs', 'Two Runs.pdf', { parent: CAMPAIGN_FOLDER }),
        listed('f-renamed', 'Renamed Deck.pdf'),
        listed('f-v2-same', 'V2 Same.pdf', { parent: CAMPAIGN_FOLDER }),
        listed('f-modified', 'Modified.pdf', { modified: M1 }),
        listed('f-fresh', 'Fresh Brief.pdf', { parent: CAMPAIGN_FOLDER }),
      ];
    }

    it('dry-run counts the stale files, normalizes legacy rows, and writes nothing', async () => {
      await seedIndexAndListing();
      const before = await allRows();

      const res = await refreshFileSnapshots({ accountId: ACCOUNT_ID });

      expect(res).toMatchObject({
        confirm: false,
        accounts: 1,
        filesSeen: 8,
        rowsPlanned: 5,
        rowsWritten: 0,
        writeFailures: 0,
        // legacy-moved and legacy-nosib: the path differs from the run's account-rooted one, or there is none.
        byReason: { unindexed: 1, renamed: 1, moved: 2, modified: 1, mime_changed: 0 },
        // legacy-same, legacy-moved and two-runs have the run's account-rooted row; legacy-nosib has none.
        legacyNormalized: 3,
        legacyUnresolved: 1,
      });
      expect(await allRows()).toBe(before);
      expect(m.warn).not.toHaveBeenCalled();
    });

    it('with --confirm writes the stale files as listing-only rows; unchanged legacy files get none', async () => {
      await seedIndexAndListing();
      const before = await allRows();

      const res = await refreshFileSnapshots({ accountId: ACCOUNT_ID, confirm: true });

      expect(res).toMatchObject({ rowsPlanned: 5, rowsWritten: 5, writeFailures: 0 });
      expect(await allRows()).toBe(before + 5);

      const written = await prisma.driveFileSnapshot.findMany({
        where: { accountId: ACCOUNT_ID, skipReason: 'index_refresh' },
        orderBy: { fileId: 'asc' },
      });
      expect(written.map((r) => r.fileId)).toEqual([
        'f-fresh',
        'f-legacy-moved',
        'f-legacy-nosib',
        'f-modified',
        'f-renamed',
      ]);
      for (const row of written) {
        expect(row).toMatchObject({
          // The v1 sync_runs reference: a catch-up row never carries one.
          syncRunId: null,
          accountId: ACCOUNT_ID,
          wasExtracted: false,
          contentHash: null,
        });
        expect(row.scannedAt.getTime()).toBeGreaterThan(Date.parse('2026-10-02T00:00:00Z'));
      }
      const by = Object.fromEntries(written.map((r) => [r.fileId, r]));
      // Account-rooted path, and the campaign the folder belongs to.
      expect(by['f-fresh']).toMatchObject({
        name: 'Fresh Brief.pdf',
        path: 'Acme / Q3 Launch / Fresh Brief.pdf',
        campaignId: CAMPAIGN_ID,
      });
      expect(by['f-legacy-moved']).toMatchObject({
        path: 'Acme / Q3 Launch / Legacy Moved.pdf',
        campaignId: CAMPAIGN_ID,
      });
      expect(by['f-renamed']).toMatchObject({
        name: 'Renamed Deck.pdf',
        path: 'Acme / Renamed Deck.pdf',
        campaignId: null,
      });
      expect(by['f-modified']!.modifiedTime).toEqual(M1);

      // The files left alone keep exactly the rows they had.
      expect(await rowsOf('f-legacy-same')).toHaveLength(2);
      expect(await rowsOf('f-two-runs')).toHaveLength(4);
      expect(await rowsOf('f-v2-same')).toHaveLength(1);

      // What GUB's file search reads is the current name.
      const view = await searchView();
      expect(view['f-renamed']!.name).toBe('Renamed Deck.pdf');
      expect(view['f-fresh']!.path).toBe('Acme / Q3 Launch / Fresh Brief.pdf');
    });

    it('a second --confirm writes nothing', async () => {
      await seedIndexAndListing();
      await refreshFileSnapshots({ accountId: ACCOUNT_ID, confirm: true });
      const after = await allRows();

      const res = await refreshFileSnapshots({ accountId: ACCOUNT_ID, confirm: true });

      expect(res).toMatchObject({ filesSeen: 8, rowsPlanned: 0, rowsWritten: 0 });
      expect(await allRows()).toBe(after);
    });

    it('prints counts only', async () => {
      await seedIndexAndListing();

      await refreshFileSnapshots({ accountId: ACCOUNT_ID, confirm: true });

      const text = m.lines.join('\n');
      expect(text).toContain(`account ${ACCOUNT_ID}`);
      for (const secret of ['Acme', 'Q3 Launch', '.pdf', 'f-legacy', 'f-fresh', CAMPAIGN_FOLDER]) {
        expect(text).not.toContain(secret);
      }
    });

    it('a refused insert is reported, the run fails after the summary, the other rows are written', async () => {
      await seedIndexAndListing();
      m.listing.files.push(listed('catchup-poison-file', 'Poison Plan.pdf'));
      await prisma.$executeRawUnsafe(
        `ALTER TABLE drive_file_snapshots ADD CONSTRAINT h4_catchup_poison_file CHECK (file_id <> 'catchup-poison-file')`,
      );

      try {
        await expect(
          refreshFileSnapshots({ accountId: ACCOUNT_ID, confirm: true }),
        ).rejects.toThrow(/1 snapshot write failure\(s\)/);
      } finally {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE drive_file_snapshots DROP CONSTRAINT IF EXISTS h4_catchup_poison_file`,
        );
      }

      expect(
        await prisma.driveFileSnapshot.count({
          where: { accountId: ACCOUNT_ID, skipReason: 'index_refresh' },
        }),
      ).toBe(5);
      expect(m.warn.mock.calls.filter(([, msg]) => msg === WRITE_FAILED)).toEqual([
        [
          {
            fileId: 'catchup-poison-file',
            accountId: ACCOUNT_ID,
            source: 'refresh',
            code: 'PrismaClientUnknownRequestError',
            constraint: null,
          },
          WRITE_FAILED,
        ],
      ]);
      // Prisma's message for a CHECK violation embeds the failing row.
      expect(JSON.stringify(m.warn.mock.calls)).not.toContain('Poison Plan');
      expect(m.lines.join('\n')).toContain(
        '1 write failure(s) [PrismaClientUnknownRequestError x1]',
      );
      expect(m.lines.join('\n')).not.toContain('Poison Plan');
    });

    it('compares files beyond the first lookup chunk (1000 ids per query)', async () => {
      // 1,001 v1 pairs, so both lookups take a second chunk; the one file in
      // it moved to the account root since v1.
      const ids = Array.from({ length: 1001 }, (_, i) => `f-bulk-${String(i).padStart(4, '0')}`);
      const v1Row = (id: string, campaign: boolean, at: string) => ({
        fileId: id,
        name: `${id}.pdf`,
        path: campaign ? `Q3 Launch / ${id}.pdf` : `Acme / Q3 Launch / ${id}.pdf`,
        mimeType: 'application/pdf',
        modifiedTime: M0,
        syncRunId: RUN_B,
        accountId: ACCOUNT_ID,
        campaignId: campaign ? CAMPAIGN_ID : null,
        scannedAt: new Date(at),
      });
      await prisma.driveFileSnapshot.createMany({
        data: ids.flatMap((id) => [
          v1Row(id, false, '2026-08-13T10:00:00Z'),
          v1Row(id, true, '2026-08-13T10:00:30Z'),
        ]),
      });
      m.listing.folders = [
        {
          ...listed(CAMPAIGN_FOLDER, 'Q3 Launch', { dir: 'Acme' }),
          mimeType: 'application/vnd.google-apps.folder',
          isFolder: true,
          parentId: null,
          depth: 1,
        },
      ];
      m.listing.files = ids.map((id, i) =>
        i === 1000 ? listed(id, `${id}.pdf`) : listed(id, `${id}.pdf`, { parent: CAMPAIGN_FOLDER }),
      );

      const res = await refreshFileSnapshots({ accountId: ACCOUNT_ID });

      expect(res).toMatchObject({
        filesSeen: 1001,
        rowsPlanned: 1,
        byReason: { unindexed: 0, renamed: 0, moved: 1, modified: 0, mime_changed: 0 },
        legacyNormalized: 1001,
        legacyUnresolved: 0,
      });
    });

    it('refuses an account id that matches nothing', async () => {
      await expect(
        refreshFileSnapshots({ accountId: '00000000-0000-4000-a000-0000000000ff' }),
      ).rejects.toThrow(/no account with that id/);
    });
  });

  describe('checkDelta', () => {
    const file = (modified: Date): TraversedFile => listed('f-delta', 'Delta.pdf', { modified });

    it('skips on the latest extraction, not on a listing-only row recording a newer version', async () => {
      await seed({
        fileId: 'f-delta',
        name: 'Delta.pdf',
        path: 'Acme / Delta.pdf',
        wasExtracted: true,
        modified: M0,
        scannedAt: '2026-10-01T10:00:00Z',
      });
      await seed({
        fileId: 'f-delta',
        name: 'Delta.pdf',
        path: 'Acme / Delta.pdf',
        skipReason: 'index_refresh',
        modified: M1,
        scannedAt: '2026-10-02T10:00:00Z',
      });

      // Drive is at M1: the file was extracted at M0 only, so it must be extracted again.
      await expect(checkDelta(file(M1))).resolves.toMatchObject({
        shouldExtract: true,
        reason: 'modified_since_last',
        lastModifiedTime: M0,
      });
      // At M0 the NULL skip_reason row still counts: Prisma's `not` alone would have dropped it.
      await expect(checkDelta(file(M0))).resolves.toMatchObject({
        shouldExtract: false,
        skipReason: 'delta_unchanged',
      });
    });

    it('a file with only a listing-only row has never been extracted', async () => {
      await seed({
        fileId: 'f-delta-listed',
        name: 'Delta.pdf',
        path: 'Acme / Delta.pdf',
        skipReason: 'index_refresh',
        modified: M1,
        scannedAt: '2026-10-02T10:00:00Z',
      });

      await expect(checkDelta({ ...file(M1), id: 'f-delta-listed' })).resolves.toMatchObject({
        shouldExtract: true,
        reason: 'first_seen',
      });
    });
  });
});
