/**
 * The bootstrap files cache on a real Postgres: how many bytes a file costs in
 * the stored value (legacy format vs version 2), and that the bootstrap path
 * still completes a chunk on a drive of 400k files.
 *
 * Skipped unless H5_PG_URL is set, and refused (the suite FAILS) unless it
 * points at a throwaway database on this machine. Setup:
 *
 *   docker run --rm -d --name h5-pg -p 55471:5432 -e POSTGRES_PASSWORD=password pgvector/pgvector:pg16
 *   docker exec h5-pg psql -U postgres -c 'CREATE DATABASE h5_scratch'
 *   # the schema = GUB's migration chain, from a scratch copy of its prisma/ dir:
 *   git -C <gcp-universal-backend checkout> archive origin/main prisma | tar -x -C <scratch dir>
 *   DATABASE_URL=postgresql://postgres:password@127.0.0.1:55471/h5_scratch \
 *     npx prisma migrate deploy --schema <scratch dir>/prisma/schema.prisma
 *
 *   H5_PG_URL=postgresql://postgres:password@127.0.0.1:55471/h5_scratch \
 *     npx vitest run src/backfill/__tests__/bootstrap-cache.pg.test.ts
 *
 * Heavy: the 400k test needs roughly 10 GiB of free RAM — Prisma's own
 * handling of a ~200 MB JSON value is what costs it (a fresh process writing
 * the 400k cache peaks near 9 GiB RSS and reading it back near 2 GiB; measured
 * numbers are in the commit message). Run this file on its own. RSS is not
 * printed here for that reason: the engine keeps what the big writes took, so
 * an in-process RSS says nothing about the read. JS heap (collected first
 * with NODE_OPTIONS=--expose-gc) is clean. H5_PG_LEGACY_400K=1 also attempts
 * the 400k write in the legacy format, to see Postgres refuse it — about
 * twice the memory again.
 *
 * The 400k synthetic files carry realistic field sizes (33-char ids, names of
 * 20-60 chars, breadcrumb paths of 60-120 chars, ISO timestamps, one parent
 * id, example.com e-mails, sizes) spread over 1,500 active days. Only the
 * pieces around the cache are mocked (structure stage, Drive discovery,
 * per-file processing); Prisma, the cache write and read, and the cursor
 * persist are real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { TraversedFile } from '../../drive/types';

const PG_URL = process.env.H5_PG_URL;

const m = vi.hoisted(() => ({
  gatherFilesAuto: vi.fn(),
  resolveAccountStructure: vi.fn(),
  processBatch: vi.fn(),
}));

vi.mock('../discovery', () => ({
  gatherFilesAuto: m.gatherFilesAuto,
  gatherFilesRecursive: vi.fn(),
}));
vi.mock('../structure-stage', () => ({ resolveAccountStructure: m.resolveAccountStructure }));
vi.mock('../structure-mode', () => ({ runStructureOnly: vi.fn() }));
vi.mock('../../scan/process-batch', () => ({ processBatch: m.processBatch }));
vi.mock('../../scan/timing', () => ({
  resetPhaseTimer: vi.fn(),
  printPhaseSummary: vi.fn(),
  timed: <T>(_phase: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

// ── Guard ────────────────────────────────────────────────────────────────────

/** Refuse anything that is not a local, scratch-named database. */
function assertThrowawayDatabase(url: string): void {
  const u = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error(`H5_PG_URL host must be localhost, got "${u.hostname}" — refusing to run`);
  }
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/scratch|throwaway|h5_test/i.test(db)) {
    throw new Error(
      `H5_PG_URL database "${db}" does not look like a scratch database ` +
        `(name must contain "scratch", "throwaway" or "h5_test") — refusing to run`,
    );
  }
}

// ── Synthetic drive ──────────────────────────────────────────────────────────

/** mulberry32 — a tiny seeded PRNG, so every run builds the same drive. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const WORDS = (
  'Acme|Brand X|Spring|Launch|Plan|Brief|Deck|Report|Budget|Notes|Draft|Final|Review|Assets|' +
  'Concept|Timeline|Summary|Pitch|Storyboard|Script|Moodboard|Survey|Results|Roadmap|Kickoff|' +
  'Retro|Proposal|Estimate|Schedule|Recap'
).split('|');
const FOLDERS = (
  'Campaigns|Spring Launch|Q3 Planning|Creative|Assets|Client Review|Final Files|Archive|' +
  'Strategy|Production|Social|Research|Reports'
).split('|');
const KINDS: Array<{ mimeType: string; ext: string; native: boolean }> = [
  { mimeType: 'application/pdf', ext: '.pdf', native: false },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
    native: false,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx',
    native: false,
  },
  { mimeType: 'application/vnd.google-apps.document', ext: '', native: true },
  { mimeType: 'application/vnd.google-apps.spreadsheet', ext: '', native: true },
  { mimeType: 'application/vnd.google-apps.presentation', ext: '', native: true },
  { mimeType: 'text/plain', ext: '.txt', native: false },
];
const DAY_MS = 86_400_000;
const FIRST_DAY_MS = Date.UTC(2021, 0, 1);

/**
 * `count` files spread over exactly `days` active days (every day has at
 * least one). modifiedTime >= createdTime, so each file lands on its
 * modifiedTime's day in groupFilesByDate.
 */
function syntheticFiles(count: number, days: number): TraversedFile[] {
  const rnd = prng(20251021);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const id = (): string => {
    let s = '1';
    for (let i = 0; i < 32; i++) s += ID_CHARS[Math.floor(rnd() * 64)];
    return s;
  };
  const folderIds = Array.from({ length: 2000 }, id);
  const emails = Array.from({ length: 300 }, (_, i) => `person.${i}@example.com`);

  const files: TraversedFile[] = [];
  for (let i = 0; i < count; i++) {
    const kind = pick(KINDS);
    // Name: 20-60 chars including the extension.
    let name = pick(WORDS);
    const stem = 20 - kind.ext.length + Math.floor(rnd() * 41);
    while (name.length < stem) name += ` ${pick(WORDS)}`;
    name = name.slice(0, 60 - kind.ext.length).replace(/ $/, 'x') + kind.ext;
    // Path: 60-120 chars of breadcrumb ending in the name.
    const segments: string[] = [];
    const pathTarget = 60 + Math.floor(rnd() * 61);
    const path = (): string => `Acme / ${segments.map((seg) => `${seg} / `).join('')}${name}`;
    while (path().length < pathTarget) segments.push(pick(FOLDERS));
    if (path().length > 120) segments.pop();

    // Every day gets a file first, then the rest pile up on the early days.
    const day = i < days ? i : Math.floor(Math.pow(rnd(), 1.6) * days);
    const modified = FIRST_DAY_MS + day * DAY_MS + Math.floor(rnd() * DAY_MS);
    const created = modified - Math.floor(rnd() * 400 * DAY_MS);
    files.push({
      id: id(),
      name,
      mimeType: kind.mimeType,
      parents: [pick(folderIds)],
      path: path(),
      modifiedTime: new Date(modified).toISOString(),
      modifiedByEmail: pick(emails),
      createdTime: new Date(created).toISOString(),
      size: kind.native ? null : Math.floor(rnd() * 50_000_000),
      isFolder: false,
    });
  }
  return files;
}

// ── Measuring ────────────────────────────────────────────────────────────────

const MiB = 1024 * 1024;
const mib = (n: number): string => (n / MiB).toFixed(1);

interface Row {
  format: string;
  files: number;
  result: string;
  storedBytes?: number;
  textBytes?: number;
  writeMs?: number;
}
const rows: Row[] = [];

/** JS heap, collected first when node runs with --expose-gc (see the header). */
function heap(): { heapUsed: number; external: number } {
  (globalThis as { gc?: () => void }).gc?.();
  const { heapUsed, external } = process.memoryUsage();
  return { heapUsed, external };
}

/** A jsonb value cannot hold more than this many bytes of elements. */
const JSONB_MAX_BYTES = 268_435_455;

describe.skipIf(!PG_URL)('bootstrap files cache on Postgres', () => {
  const TIMEOUT = 30 * 60_000;
  let prisma: PrismaClient;
  let days: typeof import('../days');
  let run: typeof import('../run');
  let accountId: string;
  let previousUrl: string | undefined;
  let urlChanged = false;

  beforeAll(async () => {
    assertThrowawayDatabase(PG_URL!);
    previousUrl = process.env.DATABASE_URL;
    // src/prisma.ts reads DATABASE_URL when it is first imported.
    process.env.DATABASE_URL = PG_URL;
    urlChanged = true;
    ({ prisma } = await import('../../prisma'));
    days = await import('../days');
    run = await import('../run');

    const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'accounts' AND column_name = 'drive_bootstrap_files'`;
    if (cols.length !== 1) {
      throw new Error(
        'accounts.drive_bootstrap_files is missing — migrate the scratch database first',
      );
    }
    const account = await prisma.account.create({
      data: { name: 'Acme (cache test)', driveFolderId: 'folder-acme' },
    });
    accountId = account.id;
  }, TIMEOUT);

  afterAll(async () => {
    if (prisma) {
      if (accountId) await prisma.account.deleteMany({ where: { id: accountId } });
      await prisma.$disconnect();
    }
    if (urlChanged) {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
    console.info(
      '\n[h5-pg] format  files  result  stored(MiB)  text(MiB)  stored B/file  text B/file  write(s)\n' +
        rows
          .map((r) => {
            const per = (b?: number): string => (b === undefined ? '-' : (b / r.files).toFixed(0));
            const sz = (b?: number): string => (b === undefined ? '-' : mib(b));
            return (
              `[h5-pg] ${r.format.padEnd(7)} ${String(r.files).padStart(6)}  ${r.result.padEnd(8)} ` +
              `${sz(r.storedBytes).padStart(10)}  ${sz(r.textBytes).padStart(9)}  ` +
              `${per(r.storedBytes).padStart(13)}  ${per(r.textBytes).padStart(11)}  ` +
              `${r.writeMs === undefined ? '-' : (r.writeMs / 1000).toFixed(1)}`
            );
          })
          .join('\n'),
    );
  }, TIMEOUT);

  /** Bytes of the stored value: on disk (possibly compressed) and as jsonb text. */
  async function storedSize(): Promise<{ storedBytes: number; textBytes: number }> {
    const [r] = await prisma.$queryRaw<Array<{ stored: number; text: number }>>`
      SELECT pg_column_size(drive_bootstrap_files)::int AS stored,
             octet_length(drive_bootstrap_files::text)::int AS text
      FROM accounts WHERE id = ${accountId}::uuid`;
    return { storedBytes: Number(r!.stored), textBytes: Number(r!.text) };
  }

  /** What the previous build wrote: `{ files, activeDates }`, files in both. */
  async function writeLegacy(files: TraversedFile[], activeDates: unknown[]): Promise<number> {
    const t0 = performance.now();
    await prisma.account.update({
      where: { id: accountId },
      data: { driveBootstrapFiles: { files, activeDates } as unknown as Prisma.InputJsonValue },
    });
    return performance.now() - t0;
  }

  it('the synthetic drive has the field sizes it claims', () => {
    const files = syntheticFiles(5000, 1500);
    const within = (n: number, lo: number, hi: number): boolean => n >= lo && n <= hi;
    expect(files.every((f) => f.id.length === 33)).toBe(true);
    expect(files.every((f) => within(f.name.length, 20, 60))).toBe(true);
    expect(files.every((f) => within(f.path.length, 60, 120))).toBe(true);
    expect(files.every((f) => f.parents?.length === 1 && f.parents[0]!.length === 33)).toBe(true);
    expect(files.every((f) => f.modifiedByEmail!.endsWith('@example.com'))).toBe(true);
    expect(files.every((f) => f.modifiedTime! >= f.createdTime!)).toBe(true);
    expect(new Set(files.map((f) => f.id)).size).toBe(files.length);
    expect(new Set(days.groupFilesByDate(files).map((d) => d.date)).size).toBe(1500);
  });

  /** Bytes per file, measured by the 100k test for the 400k one to extrapolate. */
  const perFile: { legacyText?: number; v2Text?: number } = {};

  it(
    'the same 100k files cost about half the bytes per file in version 2',
    async () => {
      const files = syntheticFiles(100_000, 1500);
      const activeDates = days.groupFilesByDate(files);
      expect(activeDates).toHaveLength(1500);

      const legacyMs = await writeLegacy(files, activeDates);
      const legacy = await storedSize();
      rows.push({
        format: 'legacy',
        files: files.length,
        result: 'stored',
        ...legacy,
        writeMs: legacyMs,
      });

      const t0 = performance.now();
      await days.persistBootstrapFilesCache(accountId, { files, activeDates });
      const v2Ms = performance.now() - t0;
      const v2 = await storedSize();
      rows.push({ format: 'v2', files: files.length, result: 'stored', ...v2, writeMs: v2Ms });
      perFile.legacyText = legacy.textBytes / files.length;
      perFile.v2Text = v2.textBytes / files.length;

      // The point of the change: about half the bytes per file. The jsonb text
      // is what the 255 MB limit counts; on disk TOAST compresses the second
      // copy of the legacy format well, so the stored ratio is a little higher.
      expect(v2.textBytes / legacy.textBytes).toBeLessThan(0.6);
      expect(v2.storedBytes / legacy.storedBytes).toBeLessThan(0.7);

      // What the new code reads back is what was written…
      const fromV2 = (await days.loadBootstrapFilesCache(accountId))!;
      expect(fromV2.files).toHaveLength(files.length);
      expect(fromV2.activeDates.map((d) => d.date)).toEqual(activeDates.map((d) => d.date));
      expect(fromV2.activeDates.map((d) => d.files.length)).toEqual(
        activeDates.map((d) => d.files.length),
      );
      expect(fromV2.activeDates[0]!.files.map((f) => f.id)).toEqual(
        activeDates[0]!.files.map((f) => f.id),
      );
      // …with one object per file, not two.
      expect(fromV2.activeDates[0]!.files[0]).toBe(
        fromV2.files.find((f) => f.id === activeDates[0]!.files[0]!.id),
      );

      // …and a cache the previous build wrote still reads through the new code.
      await writeLegacy(files, activeDates);
      const fromLegacy = (await days.loadBootstrapFilesCache(accountId))!;
      expect(fromLegacy.files).toHaveLength(files.length);
      expect(fromLegacy.activeDates).toHaveLength(1500);
      expect(fromLegacy.activeDates[0]!.files.map((f) => f.id)).toEqual(
        activeDates[0]!.files.map((f) => f.id),
      );
    },
    TIMEOUT,
  );

  it(
    '400k files: version 2 fits one jsonb value and a bootstrap chunk completes on it',
    async () => {
      const FILES = 400_000;
      const DAYS = 1500;
      if (perFile.legacyText === undefined || perFile.v2Text === undefined) {
        throw new Error('run the whole file: this test extrapolates the 100k test per-file sizes');
      }
      // Two copies of 400k files do not fit one jsonb value; one copy does.
      expect(perFile.legacyText * FILES).toBeGreaterThan(JSONB_MAX_BYTES);
      expect(perFile.v2Text * FILES).toBeLessThan(JSONB_MAX_BYTES);

      let first: { date: string; ids: string[] };
      let probe: string[];
      {
        const files = syntheticFiles(FILES, DAYS);
        const activeDates = days.groupFilesByDate(files);
        expect(activeDates).toHaveLength(DAYS);
        first = { date: activeDates[0]!.date, ids: activeDates[0]!.files.map((f) => f.id) };
        probe = [files[0]!.id, files[FILES - 1]!.id];

        const t0 = performance.now();
        await days.persistBootstrapFilesCache(accountId, { files, activeDates });
        const writeMs = performance.now() - t0;
        rows.push({
          format: 'v2',
          files: FILES,
          result: 'stored',
          ...(await storedSize()),
          writeMs,
        });
      }

      // The generated drive is out of scope now: look at the READ on its own.
      {
        const before = heap();
        const t0 = performance.now();
        const cache = (await days.loadBootstrapFilesCache(accountId))!;
        const readMs = performance.now() - t0;
        const after = heap();
        console.info(
          `[h5-pg] load+decode of the 400k cache: ${(readMs / 1000).toFixed(1)}s, ` +
            `JS heap ${mib(before.heapUsed)} -> ${mib(after.heapUsed)} MiB ` +
            `(+${mib(after.heapUsed - before.heapUsed)})`,
        );
        expect(cache.files).toHaveLength(FILES);
        expect(cache.activeDates).toHaveLength(DAYS);
        expect(cache.files.map((f) => f.id)).toEqual(expect.arrayContaining(probe));
        expect(cache.activeDates[0]!.files.map((f) => f.id)).toEqual(first.ids);
      }

      // One bootstrap chunk on the account that holds that cache: the files come
      // from the cache (discovery would throw), the first active day is scanned,
      // and the cursor is persisted.
      m.gatherFilesAuto.mockRejectedValue(new Error('discovery must not run: the cache is there'));
      m.resolveAccountStructure.mockResolvedValue({
        attributor: {},
        nameDirectory: {},
        familyByCampaignId: new Map(),
        folderPathById: new Map(),
      });
      m.processBatch.mockResolvedValue({ synthesized: [], stage3Failures: 0 });
      const captured: string[] = [];
      const t1 = performance.now();
      const result = await run.runBackfill({
        accountId,
        newestFirst: false,
        outputPath: null,
        structureOnly: false,
        dryrun: false,
        captureLog: captured,
      });
      console.info(
        `[h5-pg] runBackfill chunk on the 400k cache: ${((performance.now() - t1) / 1000).toFixed(1)}s`,
      );

      expect(m.gatherFilesAuto).not.toHaveBeenCalled();
      expect(captured).toContain(`  ✓ Files cache HIT  (${FILES} files, ${DAYS} active days)`);
      expect(m.processBatch).toHaveBeenCalledTimes(1);
      const batch = m.processBatch.mock.calls[0]![0] as TraversedFile[];
      expect(batch.map((f) => f.id)).toEqual(first.ids);
      expect(result).toMatchObject({
        scansProcessed: 1,
        filesProcessed: first.ids.length,
        finalCursorYmd: first.date,
        activeDaysCount: DAYS,
        bootstrapCompleted: false,
      });
      // The cursor really moved, in the database.
      const [row] = await prisma.$queryRaw<Array<{ cursor: string }>>`
        SELECT drive_bootstrap_cursor::text AS cursor FROM accounts WHERE id = ${accountId}::uuid`;
      expect(row!.cursor).toBe(first.date);
    },
    TIMEOUT,
  );

  // The legacy format at 400k, for real: Postgres refuses it. Opt-in — the
  // attempt alone takes about twice the memory of the version-2 write.
  it.runIf(process.env.H5_PG_LEGACY_400K === '1')(
    '400k files: Postgres refuses the legacy format',
    async () => {
      const files = syntheticFiles(400_000, 1500);
      const activeDates = days.groupFilesByDate(files);
      const t0 = performance.now();
      const error = await writeLegacy(files, activeDates).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      rows.push({
        format: 'legacy',
        files: files.length,
        result: error === null ? 'stored' : 'REJECTED',
        writeMs: performance.now() - t0,
      });
      if (error !== null) {
        console.info(`[h5-pg] legacy 400k rejected: …${error.slice(-330).replace(/\s+/g, ' ')}`);
      }
      expect(error).toContain('total size of jsonb object elements exceeds the maximum');
    },
    TIMEOUT,
  );

  it(
    'once bootstrap completes the cache is gone and reads as a miss',
    async () => {
      // persistCursor(…, setCompleted) is what the last chunk of a chain calls.
      await days.persistCursor(accountId, '2024-01-01', true);
      const [row] = await prisma.$queryRaw<Array<{ stored: number }>>`
        SELECT pg_column_size(drive_bootstrap_files)::int AS stored FROM accounts WHERE id = ${accountId}::uuid`;
      expect(row!.stored ?? 0).toBeLessThan(64);
      expect(await days.loadBootstrapFilesCache(accountId)).toBeNull();
    },
    TIMEOUT,
  );
});
