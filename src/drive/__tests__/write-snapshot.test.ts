/**
 * writeSnapshot's two run-id columns. sync_run_id references the v1 sync_runs
 * table and drive_sync_run_id the v2 drive_sync_runs queue, so a caller names
 * the column that matches its run. Prisma is mocked at the module boundary;
 * the foreign keys themselves are exercised in
 * forward/__tests__/snapshot-index.pg.test.ts against a real schema.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// snapshot.ts pulls in prisma + the logger; neither may touch a real DB/sink.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../prisma', () => ({ prisma: { driveFileSnapshot: { create } } }));
vi.mock('../../logger', () => ({ logger: { warn: vi.fn() } }));

import { writeSnapshot } from '../snapshot';
import type { TraversedFile } from '../types';

const file: TraversedFile = {
  id: 'f1',
  name: 'Brief.pdf',
  mimeType: 'application/pdf',
  path: 'Acme / Q3 Launch / Brief.pdf',
  modifiedTime: '2026-09-01T00:00:00.000Z',
  modifiedByEmail: 'editor@example.com',
  createdTime: null,
  size: null,
  isFolder: false,
};
const scope = { accountId: 'acct-1', campaignId: null };
const RUN = '8d0c4a52-3f6e-4b7a-9c1d-2e5f60718293';

const written = () => create.mock.calls[0]![0].data;

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({});
});

describe('writeSnapshot', () => {
  it('writes the queue run id as drive_sync_run_id and leaves sync_run_id null', async () => {
    await writeSnapshot({ syncRunId: null, driveSyncRunId: RUN, scope, file, wasExtracted: true });

    expect(written()).toMatchObject({
      syncRunId: null,
      driveSyncRunId: RUN,
      fileId: 'f1',
      accountId: 'acct-1',
    });
  });

  it('writes both run ids as null when the caller passes neither (the index catch-up)', async () => {
    await writeSnapshot({ syncRunId: null, scope, file, wasExtracted: false });

    expect(written().syncRunId).toBeNull();
    expect(written().driveSyncRunId).toBeNull();
  });

  it('keeps a v1 caller on sync_run_id, with drive_sync_run_id null', async () => {
    await writeSnapshot({ syncRunId: 'v1-run', scope, file, wasExtracted: true });

    expect(written().syncRunId).toBe('v1-run');
    expect(written().driveSyncRunId).toBeNull();
  });
});
