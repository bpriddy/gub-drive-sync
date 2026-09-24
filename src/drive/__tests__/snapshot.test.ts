import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('../../prisma', () => ({ prisma: { driveFileSnapshot: { findFirst } } }));

import { checkDelta, snapshotForScanOutcome } from '../snapshot';
import type { TraversedFile } from '../types';

const file: TraversedFile = {
  id: 'f1',
  name: 'Brief.pdf',
  mimeType: 'application/pdf',
  path: 'Chevy / Brief.pdf',
  modifiedTime: '2026-09-01T00:00:00.000Z',
  modifiedByEmail: null,
  createdTime: null,
  size: null,
  isFolder: false,
};
const scope = { accountId: 'acct-1', campaignId: null };

describe('snapshotForScanOutcome', () => {
  it('marks an ok outcome extracted and carries its content hash', () => {
    expect(snapshotForScanOutcome({ file, kind: 'ok', contentHash: 'h' }, scope, 'run-1')).toEqual({
      syncRunId: 'run-1',
      scope,
      file,
      wasExtracted: true,
      contentHash: 'h',
    });
  });

  it('names why a file was not extracted', () => {
    const reason = (o: Parameters<typeof snapshotForScanOutcome>[0]) =>
      snapshotForScanOutcome(o, scope, null).skipReason;
    expect(reason({ file, kind: 'skip', skipReason: 'too_large' })).toBe('too_large');
    expect(reason({ file, kind: 'skip' })).toBe('skipped');
    expect(reason({ file, kind: 'restricted' })).toBe('restricted');
    expect(reason({ file, kind: 'error' })).toBe('extract_error');
  });
});

describe('checkDelta', () => {
  it('ignores listing-only index_refresh rows, keeping rows whose skip_reason is NULL', async () => {
    findFirst.mockResolvedValue(null);
    await checkDelta(file);
    expect(findFirst.mock.calls[0]![0].where).toEqual({
      fileId: 'f1',
      OR: [{ skipReason: null }, { skipReason: { not: 'index_refresh' } }],
    });
  });
});
