/**
 * The Drive name index (drive_file_snapshots) against a real Postgres, with
 * the REAL schema: the queue, runForward, processBatch and the snapshot
 * writer all run for real. Only the outside world is mocked — Activity,
 * People, Drive metadata and extraction, the model calls, reviewer mail.
 *
 * Why this exists: the first scan-core writer stamped the drive_sync_runs
 * queue id into sync_run_id, which references sync_runs (the v1 table). Every
 * insert failed with 23503, a try/catch swallowed it, and mocked-Prisma unit
 * tests could never see a foreign key. Anything that crosses a DB constraint
 * is tested here.
 *
 * Skipped unless H4_PG_URL points at a disposable database. Set it up with
 * GUB's migration chain, NOT `prisma db push` from the gub-schemas schema:
 * that schema declares no relation on drive_file_snapshots.sync_run_id, so a
 * push would drop exactly the foreign key this file is about. The chain must
 * include migration 20261021100000_drive_sync_run_id (the drive_sync_run_id
 * columns), and the Prisma client must come from gub-schemas >= 1.8.0, the
 * release that models them.
 *
 *   docker run --rm -d --name h4-pg -p 55452:5432 -e POSTGRES_PASSWORD=password pgvector/pgvector:pg16
 *   mkdir -p /tmp/gub-prisma && git -C <gcp-universal-backend checkout> archive <ref with that migration> prisma | tar -x -C /tmp/gub-prisma
 *   DATABASE_URL=postgresql://postgres:password@localhost:55452/postgres \
 *     npx prisma migrate deploy --schema /tmp/gub-prisma/prisma/schema.prisma
 *   H4_PG_URL=postgresql://postgres:password@localhost:55452/postgres npx vitest run snapshot-index.pg
 *
 * NEVER point it at a shared database: it deletes its test account's
 * drive_sync_runs, drive_edit_stats, drive_change_proposals and
 * drive_file_snapshots rows and briefly adds a CHECK constraint to
 * drive_file_snapshots (the guard in beforeAll only lets a database on this
 * machine, named like a scratch one, through). The cleanup is scoped to that
 * account, so other H4_PG_URL files can share the database and run in
 * parallel. Model calls cannot leave this file: the Gemini settings are
 * removed from the environment and the distillation call is a stub, so
 * nothing reaches a model.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const PG_URL = vi.hoisted(() => {
  const url = process.env['H4_PG_URL'];
  if (url) process.env['DATABASE_URL'] = url;
  else process.env['DATABASE_URL'] ??= 'postgres://skipped/skipped';
  delete process.env['GCP_PROJECT_ID'];
  delete process.env['GEMINI_API_KEY'];
  return url;
});

const m = vi.hoisted(() => ({
  queryActivityWindow: vi.fn(),
  getFileMetadata: vi.fn(),
  resolveAccountStructure: vi.fn(),
  extractText: vi.fn(),
  interpretFile: vi.fn(),
  runPreset: vi.fn(),
  warn: vi.fn(),
  scanLog: [] as string[],
}));

vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn() }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: m.warn, error: vi.fn() },
}));
// The human scan log: kept (and fed to the run's capture buffer, as in
// production) instead of written to stdout.
vi.mock('../../scan/output', async (importActual) => {
  const actual = await importActual<typeof import('../../scan/output')>();
  return {
    ...actual,
    log: (line = '') => {
      m.scanLog.push(line);
      actual.getLogCapture()?.push(line);
    },
  };
});
vi.mock('../activity', async (importActual) => ({
  ...(await importActual<typeof import('../activity')>()),
  queryActivityWindow: m.queryActivityWindow,
}));
vi.mock('../people', () => ({ resolveActors: vi.fn(async () => new Map()) }));
vi.mock('../../drive/client', async (importActual) => ({
  ...(await importActual<typeof import('../../drive/client')>()),
  getFileMetadata: m.getFileMetadata,
}));
vi.mock('../../backfill/structure-stage', () => ({
  resolveAccountStructure: m.resolveAccountStructure,
}));
vi.mock('../../drive/extract', () => ({ extractText: m.extractText }));
vi.mock('../../drive/interpret', () => ({ interpretFile: m.interpretFile }));
// The distillation call (stage 3) is the one model call a scan with
// observations makes; it is a stub here.
vi.mock('../../ai', async (importActual) => ({
  ...(await importActual<typeof import('../../ai')>()),
  runPreset: m.runPreset,
}));
vi.mock('../../drive/asset-folder', () => ({
  interpretAssetFolder: vi.fn(async () => ({ observations: [], driver: 'mock' })),
}));
vi.mock('../../drive/notify', () => ({ notifyReviewers: vi.fn(async () => ({})) }));

import { config } from '../../config';
import { prisma } from '../../prisma';
import { processBackfillQueue } from '../../drive/backfill-queue';
import { reportSnapshotWriteFailure, writeSnapshot } from '../../drive/snapshot';
import type { EntityAttribution } from '../../drive/structure';
import { runForward } from '../run';

const STAFF_ID = '00000000-0000-4000-a000-0000000000c1';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000000c2';
const CAMPAIGN_ID = '00000000-0000-4000-a000-0000000000c3';
const ROOT = 'folder-root';
const CAMPAIGN_FOLDER = 'folder-q3';
const CURSOR = new Date('2026-10-19T00:00:00Z');

// One file per outcome kind (ok, skip, restricted, error), plus the file the
// CHECK constraint in the failure tests refuses.
const FILES: Record<string, { name: string; parent: string }> = {
  'f-brief': { name: 'Brief.pdf', parent: CAMPAIGN_FOLDER },
  'f-empty': { name: 'Empty.pdf', parent: ROOT },
  'f-locked': { name: 'Locked.pdf', parent: CAMPAIGN_FOLDER },
  'f-broken': { name: 'Broken.pdf', parent: ROOT },
  'poison-file': { name: 'Poison Plan.pdf', parent: ROOT },
};
const WINDOW = ['f-brief', 'f-empty', 'f-locked', 'f-broken'];
const WRITE_FAILED = '[drive.snapshot] write failed';

const ACCOUNT_ZONE: EntityAttribution = {
  ownerType: 'account',
  campaignFolderId: null,
  campaignName: null,
  matchedCampaignId: null,
  campaignStatus: null,
  pieceId: null,
  pieceName: null,
  pieceFolderId: null,
};
const CAMPAIGN_ZONE: EntityAttribution = {
  ownerType: 'campaign',
  campaignFolderId: CAMPAIGN_FOLDER,
  campaignName: 'Q3 Launch',
  matchedCampaignId: CAMPAIGN_ID,
  campaignStatus: 'existing',
  pieceId: null,
  pieceName: null,
  pieceFolderId: null,
};

const NO_OBSERVATIONS = {
  account: [],
  campaign: [],
  deckType: 'other',
  truncated: false,
  driver: 'mock',
};

/** The Activity window: one edit event per file. */
function activityFor(ids: string[]) {
  m.queryActivityWindow.mockResolvedValue(
    ids.map((fileId) => ({
      fileId,
      fileTitle: null,
      timestamp: '2026-10-19T09:00:00Z',
      action: 'edit',
      actorResource: null,
    })),
  );
}

const newRun = (mode = 'forward') =>
  prisma.driveSyncRun.create({ data: { accountId: ACCOUNT_ID, mode, requestedBy: STAFF_ID } });
const snapshots = () =>
  prisma.driveFileSnapshot.findMany({
    where: { accountId: ACCOUNT_ID },
    orderBy: { fileId: 'asc' },
  });
const proposals = () =>
  prisma.driveChangeProposal.findMany({
    where: { accountId: ACCOUNT_ID },
    orderBy: { kind: 'asc' },
  });
const cursor = async () =>
  (await prisma.account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } })).driveForwardCursorAt;
const writeFailures = () => m.warn.mock.calls.filter(([, msg]) => msg === WRITE_FAILED);

/** Runs `fn` with a CHECK that makes Postgres refuse the poison file's row. */
async function withPoisonConstraint<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE drive_file_snapshots ADD CONSTRAINT h4_test_poison_file CHECK (file_id <> 'poison-file')`,
  );
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE drive_file_snapshots DROP CONSTRAINT IF EXISTS h4_test_poison_file`,
    );
  }
}

describe.skipIf(!PG_URL)('Drive name index against Postgres (real schema)', () => {
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
      `ALTER TABLE drive_file_snapshots DROP CONSTRAINT IF EXISTS h4_test_poison_file`,
    );
    await prisma.staff.upsert({
      where: { id: STAFF_ID },
      create: {
        id: STAFF_ID,
        fullName: 'Index Test',
        email: 'index-test@example.com',
        startedAt: new Date('2026-01-01'),
      },
      update: {},
    });
    await prisma.account.upsert({
      where: { id: ACCOUNT_ID },
      create: {
        id: ACCOUNT_ID,
        name: 'Acme',
        driveFolderId: ROOT,
        driveBootstrapCompletedAt: new Date('2026-10-01T00:00:00Z'),
        driveForwardCursorAt: CURSOR,
      },
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
    // Already on the restricted worklist: a first sighting would push an
    // observation and pull distillation into a test about the index.
    await prisma.driveRestrictedFile.upsert({
      where: { accountId_fileId: { accountId: ACCOUNT_ID, fileId: 'f-locked' } },
      create: { accountId: ACCOUNT_ID, fileId: 'f-locked', name: 'Locked.pdf' },
      update: {},
    });
  });

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.warn.mockClear();
    m.scanLog.length = 0;
    config.SNAPSHOT_WRITE_FAILURE_LIMIT = 0;

    await prisma.driveFileSnapshot.deleteMany({ where: { accountId: ACCOUNT_ID } });
    await prisma.driveChangeProposal.deleteMany({ where: { accountId: ACCOUNT_ID } });
    await prisma.driveEditStat.deleteMany({ where: { accountId: ACCOUNT_ID } });
    await prisma.driveSyncRun.deleteMany({ where: { accountId: ACCOUNT_ID } });
    await prisma.account.update({
      where: { id: ACCOUNT_ID },
      data: {
        driveForwardCursorAt: CURSOR,
        driveBootstrapCompletedAt: new Date('2026-10-01T00:00:00Z'),
        driveBootstrapCursor: null,
        driveBootstrapFiles: Prisma.JsonNull,
      },
    });

    activityFor(WINDOW);
    m.getFileMetadata.mockImplementation(async (id: string) => ({
      id,
      name: FILES[id]!.name,
      mimeType: 'application/pdf',
      parents: [FILES[id]!.parent],
      modifiedTime: '2026-10-19T09:00:00.000Z',
      createdTime: '2026-10-01T09:00:00.000Z',
      size: '2048',
      lastModifyingUser: { emailAddress: 'editor@example.com' },
    }));
    m.resolveAccountStructure.mockResolvedValue({
      attributor: (parent: string | null | undefined) =>
        parent === CAMPAIGN_FOLDER ? CAMPAIGN_ZONE : ACCOUNT_ZONE,
      nameDirectory: {
        knownCampaignNames: ['Q3 Launch'],
        existingByName: new Map(),
        newFolderByName: new Map(),
      },
      familyByCampaignId: new Map([[CAMPAIGN_ID, ['Q3 Launch']]]),
      folderPathById: new Map([[CAMPAIGN_FOLDER, 'Acme / Q3 Launch']]),
    });
    m.extractText.mockImplementation(async (f: { id: string }) => {
      if (f.id === 'f-empty') return { kind: 'skip', reason: 'empty' };
      if (f.id === 'f-locked') throw Object.assign(new Error('forbidden'), { code: 403 });
      if (f.id === 'f-broken') throw new Error('parser exploded');
      return { kind: 'ok', text: 'brief text', contentHash: `hash-${f.id}`, extractor: 'text' };
    });
    // Zero observations: stage 3 has nothing to distill, so no model call is
    // even attempted.
    m.interpretFile.mockResolvedValue(NO_OBSERVATIONS);
    m.runPreset.mockReset();
    m.runPreset.mockRejectedValue(new Error('unexpected distillation call'));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.$disconnect();
  });

  it('a queue-driven forward run writes one drive_file_snapshots row per scanned file', async () => {
    const run = await newRun();

    const summary = await processBackfillQueue();

    expect(summary).toMatchObject({ processed: 1, completed: 1, failed: 0, retriedLater: 0 });
    const done = await prisma.driveSyncRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'completed', errorMessage: null, filesProcessed: 4 });
    expect((await cursor())!.getTime()).toBeGreaterThan(CURSOR.getTime());

    const rows = await snapshots();
    expect(rows.map((r) => r.fileId)).toEqual(['f-brief', 'f-broken', 'f-empty', 'f-locked']);
    const by = Object.fromEntries(rows.map((r) => [r.fileId, r]));
    // The queue run lives in drive_sync_runs, so it goes in drive_sync_run_id;
    // sync_run_id references sync_runs (the v1 table) and stays NULL.
    expect(rows.map((r) => r.syncRunId)).toEqual([null, null, null, null]);
    expect(rows.map((r) => r.driveSyncRunId)).toEqual([run.id, run.id, run.id, run.id]);
    expect(rows.every((r) => r.accountId === ACCOUNT_ID && r.scannedAt instanceof Date)).toBe(true);
    expect(by['f-brief']).toMatchObject({
      campaignId: CAMPAIGN_ID,
      name: 'Brief.pdf',
      mimeType: 'application/pdf',
      path: 'Acme / Q3 Launch / Brief.pdf',
      modifiedBy: 'editor@example.com',
      sizeBytes: 2048n,
      wasExtracted: true,
      contentHash: 'hash-f-brief',
      skipReason: null,
    });
    expect(by['f-empty']).toMatchObject({
      campaignId: null,
      path: 'Acme / Empty.pdf',
      wasExtracted: false,
      contentHash: null,
      skipReason: 'empty',
    });
    expect(by['f-locked']).toMatchObject({
      campaignId: CAMPAIGN_ID,
      wasExtracted: false,
      skipReason: 'restricted',
    });
    expect(by['f-broken']).toMatchObject({
      campaignId: null,
      wasExtracted: false,
      skipReason: 'extract_error',
    });
    expect(writeFailures()).toHaveLength(0);
  });

  it('appends on every run and never rewrites an earlier row', async () => {
    await newRun();
    await processBackfillQueue();
    const first = await snapshots();
    expect(first).toHaveLength(4);

    await newRun();
    await processBackfillQueue();
    const all = await snapshots();

    expect(all).toHaveLength(8);
    const byId = new Map(all.map((r) => [r.id, r]));
    for (const row of first) expect(byId.get(row.id)).toEqual(row);
  });

  it('a queue-driven bootstrap run stamps its run id on its snapshot rows too', async () => {
    // Chunks of a bootstrap chain read their file list from the account row,
    // so no Drive discovery is involved.
    const day = '2026-09-01';
    const files = WINDOW.map((id) => ({
      id,
      name: FILES[id]!.name,
      mimeType: 'application/pdf',
      parents: [FILES[id]!.parent],
      path:
        FILES[id]!.parent === CAMPAIGN_FOLDER
          ? `Acme / Q3 Launch / ${FILES[id]!.name}`
          : `Acme / ${FILES[id]!.name}`,
      modifiedTime: `${day}T10:00:00.000Z`,
      modifiedByEmail: 'editor@example.com',
      createdTime: null,
      size: 2048,
      isFolder: false,
    }));
    await prisma.account.update({
      where: { id: ACCOUNT_ID },
      data: {
        driveBootstrapCompletedAt: null,
        driveBootstrapFiles: { files, activeDates: [{ date: day, files }] },
      },
    });
    const run = await newRun('bootstrap');

    const summary = await processBackfillQueue();

    expect(summary).toMatchObject({ processed: 1, completed: 1, failed: 0, retriedLater: 0 });
    const done = await prisma.driveSyncRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'completed', errorMessage: null });
    const rows = await snapshots();
    expect(rows.map((r) => r.fileId)).toEqual(['f-brief', 'f-broken', 'f-empty', 'f-locked']);
    expect(rows.map((r) => r.syncRunId)).toEqual([null, null, null, null]);
    expect(rows.map((r) => r.driveSyncRunId)).toEqual([run.id, run.id, run.id, run.id]);
    expect(writeFailures()).toHaveLength(0);
  });

  describe('review proposals', () => {
    /**
     * A forward run whose brief yields one campaign observation. The (stubbed)
     * distillation turns it into a budget change and a note, which the propose
     * path writes as two drive_change_proposals rows.
     */
    async function proposingRun() {
      m.interpretFile.mockImplementation(async (input: { file: { id: string } }) =>
        input.file.id === 'f-brief'
          ? {
              ...NO_OBSERVATIONS,
              campaign: [
                {
                  text: 'Launch moved to October; budget is 250000',
                  reasoning: 'Stated in the brief',
                  confidence: 0.9,
                },
              ],
            }
          : NO_OBSERVATIONS,
      );
      m.runPreset.mockResolvedValue({
        text: JSON.stringify({
          field_changes: [
            {
              field: 'budget',
              proposed_value: '250000',
              reasoning: 'The brief states the budget',
              source_file_ids: ['f-brief'],
              confidence: 0.9,
            },
          ],
          notes: [{ text: 'Launch moved to October', source_file_ids: ['f-brief'] }],
          ambiguous: [],
        }),
        driver: 'mock',
        model: 'mock',
        prompt: '',
      });
      const run = await newRun();
      await processBackfillQueue();
      const done = await prisma.driveSyncRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(done).toMatchObject({ status: 'completed', errorMessage: null });
      return run;
    }

    it('a forward run stamps the run id on the proposals it writes', async () => {
      const run = await proposingRun();

      const rows = await proposals();
      expect(rows.map((r) => [r.kind, r.property])).toEqual([
        ['additional_update', '__note__'],
        ['field_change', 'budget'],
      ]);
      expect(rows.every((r) => r.campaignId === CAMPAIGN_ID && r.state === 'pending')).toBe(true);
      // sync_run_id references the v1 sync_runs table; the queue run is in drive_sync_run_id.
      expect(rows.map((r) => r.syncRunId)).toEqual([null, null]);
      expect(rows.map((r) => r.driveSyncRunId)).toEqual([run.id, run.id]);
    });

    it('deleting a run keeps its snapshots and proposals and nulls their drive_sync_run_id', async () => {
      const run = await proposingRun();
      const [snapshotsBefore, proposalsBefore] = [await snapshots(), await proposals()];
      expect(snapshotsBefore).toHaveLength(4);
      expect(proposalsBefore).toHaveLength(2);
      expect(snapshotsBefore.every((r) => r.driveSyncRunId === run.id)).toBe(true);
      expect(proposalsBefore.every((r) => r.driveSyncRunId === run.id)).toBe(true);

      await prisma.driveSyncRun.delete({ where: { id: run.id } });

      // ON DELETE SET NULL: the rows outlive the queue row they came from.
      const snapshotsAfter = await snapshots();
      const proposalsAfter = await proposals();
      expect(snapshotsAfter.map((r) => r.id)).toEqual(snapshotsBefore.map((r) => r.id));
      expect(proposalsAfter.map((r) => r.id)).toEqual(proposalsBefore.map((r) => r.id));
      expect(snapshotsAfter.every((r) => r.driveSyncRunId === null)).toBe(true);
      expect(proposalsAfter.every((r) => r.driveSyncRunId === null)).toBe(true);
    });
  });

  // A schema guard more than a code test: its foreign-key assertions hold for
  // any writer on a database built from GUB's migrations, and fail on a
  // `prisma db push` one, where this foreign key does not exist.
  it('stamping a drive_sync_runs id into sync_run_id — what e822aec did — fails with 23503', async () => {
    const run = await newRun();
    const input = {
      syncRunId: run.id,
      scope: { accountId: ACCOUNT_ID, campaignId: null },
      file: {
        id: 'f-fk',
        name: 'Fk.pdf',
        mimeType: 'application/pdf',
        path: 'Acme / Fk.pdf',
        modifiedTime: null,
        modifiedByEmail: null,
        createdTime: null,
        size: null,
        isFolder: false,
      },
      wasExtracted: false,
    };

    // The id is a real queue row — and not a sync_runs row.
    const [{ n }] = await prisma.$queryRaw<[{ n: bigint }]>`
      SELECT count(*) AS n FROM sync_runs WHERE id = ${run.id}::uuid`;
    expect(n).toBe(0n);
    expect(await prisma.driveSyncRun.count({ where: { id: run.id } })).toBe(1);

    const viaPrisma = await writeSnapshot(input).then(
      () => null,
      (e: unknown) => e,
    );
    expect(viaPrisma).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(viaPrisma).toMatchObject({
      code: 'P2003',
      meta: { field_name: 'drive_file_snapshots_sync_run_id_fkey (index)' },
    });

    // The same insert as raw SQL names Postgres' own error: 23503
    // foreign_key_violation, surfaced by Prisma as P2010.
    const viaSql = await prisma.$executeRaw`
      INSERT INTO drive_file_snapshots (sync_run_id, file_id, name)
      VALUES (${run.id}::uuid, 'f-fk', 'Fk.pdf')`.then(
      () => null,
      (e: unknown) => e,
    );
    expect(viaSql).toMatchObject({
      code: 'P2010',
      meta: { code: '23503' },
    });
    expect((viaSql as Prisma.PrismaClientKnownRequestError).meta?.['message']).toContain(
      'drive_file_snapshots_sync_run_id_fkey',
    );

    // The reporter turns exactly that error into the WARN's code + constraint.
    const why = reportSnapshotWriteFailure(
      { fileId: 'f-fk', accountId: ACCOUNT_ID, source: 'scan' },
      viaPrisma,
    );
    expect(why).toBe('P2003 drive_file_snapshots_sync_run_id_fkey (index)');
    expect(await snapshots()).toHaveLength(0);
  });

  it('the queue id belongs in drive_sync_run_id; an id that is no queue row is refused by its own foreign key', async () => {
    const run = await newRun();
    const input = {
      syncRunId: null,
      scope: { accountId: ACCOUNT_ID, campaignId: null },
      file: {
        id: 'f-fk',
        name: 'Fk.pdf',
        mimeType: 'application/pdf',
        path: 'Acme / Fk.pdf',
        modifiedTime: null,
        modifiedByEmail: null,
        createdTime: null,
        size: null,
        isFolder: false,
      },
      wasExtracted: false,
    };

    // The id that failed in sync_run_id is accepted here.
    await writeSnapshot({ ...input, driveSyncRunId: run.id });
    expect((await snapshots()).map((r) => r.driveSyncRunId)).toEqual([run.id]);

    // The column is no free-for-all: a made-up id fails its own foreign key.
    const ghost = await writeSnapshot({ ...input, driveSyncRunId: randomUUID() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(ghost).toMatchObject({
      code: 'P2003',
      meta: { field_name: 'drive_file_snapshots_drive_sync_run_id_fkey (index)' },
    });
    expect(
      reportSnapshotWriteFailure({ fileId: 'f-fk', accountId: ACCOUNT_ID, source: 'scan' }, ghost),
    ).toBe('P2003 drive_file_snapshots_drive_sync_run_id_fkey (index)');
    expect(await snapshots()).toHaveLength(1);
  });

  it('a snapshot that fails to write fails the run and holds the cursor', async () => {
    const run = await newRun();
    activityFor([...WINDOW, 'poison-file']);
    const captureLog: string[] = [];

    await withPoisonConstraint(async () => {
      await expect(
        runForward({ accountId: ACCOUNT_ID, syncRunId: run.id, captureLog }),
      ).rejects.toThrow(
        /1 snapshot write failure\(s\) \(SNAPSHOT_WRITE_FAILURE_LIMIT=0\) — cursor NOT advanced/,
      );
    });

    expect(await cursor()).toEqual(CURSOR);
    // Append-only partial: every other file's row IS written.
    expect((await snapshots()).map((r) => r.fileId)).toEqual([
      'f-brief',
      'f-broken',
      'f-empty',
      'f-locked',
    ]);
    // One WARN, ids and a code only. Prisma reports a CHECK violation as an
    // unknown request error whose message embeds the failing row (name, path):
    // neither log may carry it. (The scan log names the file by design.)
    expect(writeFailures()).toEqual([
      [
        {
          fileId: 'poison-file',
          accountId: ACCOUNT_ID,
          source: 'scan',
          code: 'PrismaClientUnknownRequestError',
          constraint: null,
        },
        WRITE_FAILED,
      ],
    ]);
    expect(JSON.stringify(m.warn.mock.calls)).not.toContain('Poison Plan');
    const scanLog = captureLog.join('\n');
    expect(scanLog).toContain(
      '✗ snapshot write failed for Poison Plan.pdf: PrismaClientUnknownRequestError',
    );
    expect(scanLog).not.toMatch(/Failing row|check constraint/);
  });

  it('with SNAPSHOT_WRITE_FAILURE_LIMIT=1 the same window completes and advances the cursor', async () => {
    const run = await newRun();
    activityFor([...WINDOW, 'poison-file']);
    config.SNAPSHOT_WRITE_FAILURE_LIMIT = 1;

    await withPoisonConstraint(async () => {
      await expect(runForward({ accountId: ACCOUNT_ID, syncRunId: run.id })).resolves.toMatchObject(
        {
          filesProcessed: 5,
        },
      );
    });

    expect((await cursor())!.getTime()).toBeGreaterThan(CURSOR.getTime());
    expect(await snapshots()).toHaveLength(4);
    expect(writeFailures()).toHaveLength(1);
  });
});
