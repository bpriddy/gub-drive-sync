/**
 * The unchanged-content gate's reads against Postgres: the batched latest-
 * extracted-hash lookup (raw SQL, DISTINCT ON) and the last-completed-run
 * cutoff. Mocks cannot show that the SQL picks the right row.
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
 * account and files.
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
import { lastCompletedRunAt } from '../../scan/content-gate';

const STAFF_ID = '00000000-0000-4000-a000-0000000007c1';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000007c2';
const FILES = ['h7c-a', 'h7c-b', 'h7c-c', 'h7c-d'];
const t = (iso: string) => new Date(iso);

async function row(
  fileId: string,
  scannedAt: string,
  wasExtracted: boolean,
  contentHash: string | null,
  skipReason: string | null = null,
) {
  await prisma.driveFileSnapshot.create({
    data: {
      fileId,
      accountId: ACCOUNT_ID,
      name: `${fileId}.pdf`,
      wasExtracted,
      contentHash,
      skipReason,
      scannedAt: t(scannedAt),
    },
  });
}

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
    await prisma.account.upsert({
      where: { id: ACCOUNT_ID },
      create: { id: ACCOUNT_ID, name: 'Gate Test Account' },
      update: {},
    });
  });

  beforeEach(cleanup);

  afterAll(async () => {
    if (!PG_URL) return;
    await cleanup();
    await prisma.account.deleteMany({ where: { id: ACCOUNT_ID } });
    await prisma.staff.deleteMany({ where: { id: STAFF_ID } });
    await prisma.$disconnect();
  });

  it('returns the hash of each file latest extracted row at or before the cutoff', async () => {
    // a: two extracted rows, then a skip row (content_unchanged) after them.
    await row('h7c-a', '2026-10-01T00:00:00Z', true, 'v2:old');
    await row('h7c-a', '2026-10-02T00:00:00Z', true, 'v2:new');
    await row('h7c-a', '2026-10-03T00:00:00Z', false, null, 'content_unchanged');
    // b: never extracted.
    await row('h7c-b', '2026-10-01T00:00:00Z', false, null, 'unsupported_mime');
    // c: extracted only after the cutoff (an attempt that did not commit).
    await row('h7c-c', '2026-10-05T00:00:00Z', true, 'v2:uncommitted');
    // d: an extracted row from before the gate, with no hash stored.
    await row('h7c-d', '2026-10-01T00:00:00Z', true, null);

    const cutoff = t('2026-10-04T00:00:00Z');
    const got = await loadLastExtractedHashes([...FILES, 'h7c-a', 'not-indexed'], cutoff);

    expect(Object.fromEntries(got)).toEqual({ 'h7c-a': 'v2:new' });
  });

  it('respects the cutoff inside one file history', async () => {
    await row('h7c-a', '2026-10-01T00:00:00Z', true, 'v2:old');
    await row('h7c-a', '2026-10-02T00:00:00Z', true, 'v2:new');

    const got = await loadLastExtractedHashes(['h7c-a'], t('2026-10-01T12:00:00Z'));
    expect(got.get('h7c-a')).toBe('v2:old');
  });

  it('accepts the new skip_reason values (no CHECK on the column)', async () => {
    await row('h7c-a', '2026-10-01T00:00:00Z', false, null, 'content_unchanged');
    await row('h7c-b', '2026-10-01T00:00:00Z', false, null, 'trashed');
    expect(await prisma.driveFileSnapshot.count({ where: { fileId: { in: FILES } } })).toBe(2);
  });

  it('lastCompletedRunAt: the newest completed run of the account, null before any', async () => {
    expect(await lastCompletedRunAt(ACCOUNT_ID)).toBeNull();
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
    expect(await lastCompletedRunAt(ACCOUNT_ID)).toEqual(t('2026-10-04T00:00:00Z'));
  });
});
