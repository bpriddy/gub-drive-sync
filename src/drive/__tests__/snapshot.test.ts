import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// snapshot.ts pulls in prisma + the logger; neither may touch a real DB/sink.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../prisma', () => ({ prisma: {} }));
vi.mock('../../logger', () => ({ logger: { warn } }));

import { reportSnapshotWriteFailure, snapshotForScanOutcome } from '../snapshot';
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

describe('snapshotForScanOutcome', () => {
  it('marks an ok outcome extracted and carries its content hash', () => {
    expect(snapshotForScanOutcome({ file, kind: 'ok', contentHash: 'h' }, scope)).toEqual({
      syncRunId: null,
      scope,
      file,
      wasExtracted: true,
      contentHash: 'h',
    });
  });

  it('names why a file was not extracted', () => {
    const reason = (o: Parameters<typeof snapshotForScanOutcome>[0]) =>
      snapshotForScanOutcome(o, scope).skipReason;
    expect(reason({ file, kind: 'skip', skipReason: 'too_large' })).toBe('too_large');
    expect(reason({ file, kind: 'skip' })).toBe('skipped');
    expect(reason({ file, kind: 'restricted' })).toBe('restricted');
    expect(reason({ file, kind: 'error' })).toBe('extract_error');
  });

  it('never stamps a run id: sync_run_id references the v1 sync_runs table', () => {
    for (const kind of ['ok', 'skip', 'restricted', 'error'] as const) {
      expect(snapshotForScanOutcome({ file, kind }, scope).syncRunId).toBeNull();
    }
  });

  it('sets content_hash on extracted rows only', () => {
    expect(snapshotForScanOutcome({ file, kind: 'ok', contentHash: 'h' }, scope).contentHash).toBe(
      'h',
    );
    for (const kind of ['skip', 'restricted', 'error'] as const) {
      const row = snapshotForScanOutcome({ file, kind, contentHash: 'stale' }, scope);
      expect(row.contentHash ?? null).toBeNull();
    }
  });
});

describe('reportSnapshotWriteFailure', () => {
  const where = { fileId: 'f1', accountId: 'acct-1', source: 'scan' as const };

  beforeEach(() => warn.mockClear());

  it('warns once, with the exact message and only ids and codes', () => {
    const fk = new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
      code: 'P2003',
      clientVersion: '5.22.0',
      meta: {
        modelName: 'DriveFileSnapshot',
        field_name: 'drive_file_snapshots_sync_run_id_fkey (index)',
      },
    });

    const why = reportSnapshotWriteFailure(where, fk);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        fileId: 'f1',
        accountId: 'acct-1',
        source: 'scan',
        code: 'P2003',
        constraint: 'drive_file_snapshots_sync_run_id_fkey (index)',
      },
      '[drive.snapshot] write failed',
    );
    expect(why).toBe('P2003 drive_file_snapshots_sync_run_id_fkey (index)');
  });

  it('never echoes the error message: a validation error prints the query arguments', () => {
    const leaky = new Prisma.PrismaClientValidationError(
      'Invalid `prisma.driveFileSnapshot.create()` invocation:\n' +
        '{ data: { name: "Brief.pdf", path: "Acme / Q3 Launch / Brief.pdf", modifiedBy: "editor@example.com" } }',
      { clientVersion: '5.22.0' },
    );

    const why = reportSnapshotWriteFailure({ ...where, source: 'refresh' }, leaky);

    const [fields, message] = warn.mock.calls[0]!;
    expect(Object.keys(fields).sort()).toEqual([
      'accountId',
      'code',
      'constraint',
      'fileId',
      'source',
    ]);
    expect(fields).toMatchObject({ source: 'refresh', code: 'PrismaClientValidationError' });
    expect(fields.constraint).toBeNull();
    expect(message).toBe('[drive.snapshot] write failed');
    const everything = JSON.stringify([warn.mock.calls, why]);
    for (const secret of ['Brief.pdf', 'Q3 Launch', 'editor@example.com', 'Invalid']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('names the Prisma code of a connection failure and falls back to the error name', () => {
    const down = new Prisma.PrismaClientInitializationError(
      'cannot reach the database',
      '5.22.0',
      'P1001',
    );
    expect(reportSnapshotWriteFailure(where, down)).toBe('P1001');
    expect(reportSnapshotWriteFailure(where, new TypeError('boom'))).toBe('TypeError');
    expect(reportSnapshotWriteFailure({ ...where, accountId: null }, 'a thrown string')).toBe(
      'unknown',
    );
    expect(warn.mock.calls[2]![0]).toMatchObject({ accountId: null, code: 'unknown' });
  });

  it('only takes a constraint from meta when it is a string', () => {
    const notNull = Object.assign(new Error('Null constraint violation'), {
      code: 'P2011',
      meta: { constraint: ['file_id'] },
    });
    expect(reportSnapshotWriteFailure(where, notNull)).toBe('P2011');
  });
});
