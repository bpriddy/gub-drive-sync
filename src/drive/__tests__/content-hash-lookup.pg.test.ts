/**
 * The unchanged-content gate's reads against Postgres: the batched lookup of
 * each file's newest relevant row (raw SQL, DISTINCT ON) and the cutoff from
 * the account's last completed run. Mocks cannot show that the SQL picks the
 * right row.
 *
 * Skipped unless H7C_PG_URL points at a disposable database built from GUB's
 * migration chain (the same recipe as snapshot-index.pg.test.ts):
 *
 *   docker run --rm -d --name h7c-pg -p 55473:5432 -e POSTGRES_PASSWORD=password pgvector/pgvector:pg16
 *   git -C <gcp-universal-backend checkout> archive origin/main prisma | tar -x -C <scratch dir>
 *   DATABASE_URL=postgresql://postgres:password@localhost:55473/postgres \
 *     npx prisma migrate deploy --schema <scratch dir>/prisma/schema.prisma
 *   H7C_PG_URL=postgresql://postgres:password@localhost:55473/postgres npx vitest run content-hash-lookup.pg
 *
 * Never point it at a shared database: it deletes the rows of its own test
 * accounts and files.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PG_URL = vi.hoisted(() => {
  const url = process.env['H7C_PG_URL'];
  if (url) process.env['DATABASE_URL'] = url;
  else process.env['DATABASE_URL'] ??= 'postgres://skipped/skipped';
  return url;
});

import { prisma } from '../../prisma';
import { loadLastExtractedHashes } from '../snapshot';
import { CUTOFF_SKEW_MS, gateCutoff } from '../../scan/content-gate';

const STAFF_ID = '00000000-0000-4000-a000-0000000007c1';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000007c2';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-a000-0000000007c3';
const FILES = ['h7c-a', 'h7c-b', 'h7c-c', 'h7c-d', 'h7c-e'];
const t = (iso: string) => new Date(iso);
const CUTOFF = t('2026-10-10T00:00:00Z');

async function row(
  fileId: string,
  scannedAt: string,
  wasExtracted: boolean,
  contentHash: string | null,
  skipReason: string | null = null,
  accountId = ACCOUNT_ID,
) {
  await prisma.driveFileSnapshot.create({
    data: {
      fileId,
      accountId,
      name: `${fileId}.pdf`,
      wasExtracted,
      contentHash,
      skipReason,
      scannedAt: t(scannedAt),
    },
  });
}

const lookup = async (ids: string[], cutoff = CUTOFF) =>
  Object.fromEntries(await loadLastExtractedHashes(ACCOUNT_ID, ids, cutoff));

async function cleanup() {
  await prisma.driveFileSnapshot.deleteMany({ where: { fileId: { in: FILES } } });
  await prisma.driveSyncRun.deleteMany({ where: { accountId: ACCOUNT_ID } });
}

describe.skipIf(!PG_URL)('unchanged-content gate reads against Postgres', () => {
  beforeAll(async () => {
    const host = new URL(PG_URL!);
    if (!['localhost', '127.0.0.1'].includes(host.hostname) || host.port === '5432') {
      throw new Error('H7C_PG_URL must be a throwaway database on this machine, not port 5432');
    }
    await prisma.staff.upsert({
      where: { id: STAFF_ID },
      create: {
        id: STAFF_ID,
        fullName: 'Gate Test',
        email: 'gate-test@example.com',
        startedAt: t('2026-01-01'),
      },
      update: {},
    });
    for (const [id, name] of [
      [ACCOUNT_ID, 'Gate Test Account'],
      [OTHER_ACCOUNT_ID, 'Other Gate Account'],
    ] as const) {
      await prisma.account.upsert({ where: { id }, create: { id, name }, update: {} });
    }
  });

  beforeEach(cleanup);

  afterAll(async () => {
    if (!PG_URL) return;
    await cleanup();
    await prisma.account.deleteMany({ where: { id: { in: [ACCOUNT_ID, OTHER_ACCOUNT_ID] } } });
    await prisma.staff.deleteMany({ where: { id: STAFF_ID } });
    await prisma.$disconnect();
  });

  it('takes the newest extracted row; content_unchanged, trashed and index_refresh are looked through', async () => {
    await row('h7c-a', '2026-10-01T00:00:00Z', true, 'v2:old');
    await row('h7c-a', '2026-10-02T00:00:00Z', true, 'v2:new');
    await row('h7c-a', '2026-10-03T00:00:00Z', false, null, 'content_unchanged');
    await row('h7c-a', '2026-10-04T00:00:00Z', false, null, 'trashed');
    await row('h7c-a', '2026-10-05T00:00:00Z', false, null, 'index_refresh');

    expect(await lookup(['h7c-a', 'h7c-a', 'not-indexed'])).toEqual({ 'h7c-a': 'v2:new' });
  });

  it('a newer failure or skip vetoes: no fall-back to the older extracted row', async () => {
    await row('h7c-a', '2026-10-01T00:00:00Z', true, 'v2:a');
    await row('h7c-a', '2026-10-02T00:00:00Z', false, null, 'extract_error');
    await row('h7c-b', '2026-10-01T00:00:00Z', true, 'v2:b');
    await row('h7c-b', '2026-10-02T00:00:00Z', false, null, 'restricted');
    // Never extracted at all.
    await row('h7c-c', '2026-10-01T00:00:00Z', false, null, 'unsupported_mime');

    expect(await lookup(['h7c-a', 'h7c-b', 'h7c-c'])).toEqual({});
  });

  it('the newest extracted row after the cutoff (an uncommitted attempt) vetoes as well', async () => {
    await row('h7c-a', '2026-10-01T00:00:00Z', true, 'v2:committed');
    await row('h7c-a', '2026-10-11T00:00:00Z', true, 'v2:uncommitted');

    expect(await lookup(['h7c-a'])).toEqual({});
    // Once a later run completes, the same row counts.
    expect(await lookup(['h7c-a'], t('2026-10-12T00:00:00Z'))).toEqual({
      'h7c-a': 'v2:uncommitted',
    });
  });

  it('ignores an extracted row with no hash (a pre-gate row or a failed idea pass)', async () => {
    await row('h7c-d', '2026-10-01T00:00:00Z', true, null);
    expect(await lookup(['h7c-d'])).toEqual({});
  });

  it("reads only the account's own rows", async () => {
    await row('h7c-e', '2026-10-01T00:00:00Z', true, 'v2:elsewhere', null, OTHER_ACCOUNT_ID);
    expect(await lookup(['h7c-e'])).toEqual({});
  });

  it('accepts the new skip_reason values (no CHECK on the column)', async () => {
    await row('h7c-a', '2026-10-01T00:00:00Z', false, null, 'content_unchanged');
    await row('h7c-b', '2026-10-01T00:00:00Z', false, null, 'trashed');
    expect(await prisma.driveFileSnapshot.count({ where: { fileId: { in: FILES } } })).toBe(2);
  });

  it('gateCutoff: the newest completed run less the skew margin, null before any', async () => {
    expect(await gateCutoff(ACCOUNT_ID)).toBeNull();
    const base = { accountId: ACCOUNT_ID, requestedBy: STAFF_ID, mode: 'forward' };
    await prisma.driveSyncRun.createMany({
      data: [
        { ...base, status: 'completed', completedAt: t('2026-10-02T00:00:00Z') },
        { ...base, status: 'completed', completedAt: t('2026-10-04T00:00:00Z') },
        // A later failed attempt must not move the cutoff.
        { ...base, status: 'failed', completedAt: t('2026-10-05T00:00:00Z') },
        { ...base, status: 'running' },
      ],
    });
    expect(await gateCutoff(ACCOUNT_ID)).toEqual(
      new Date(t('2026-10-04T00:00:00Z').getTime() - CUTOFF_SKEW_MS),
    );
  });
});
