/**
 * drive.snapshot.ts — Per-file history + delta skip.
 *
 * Delta rule: if the most recent snapshot for this file_id has a modified_time
 * at or after Drive's current modifiedTime, we skip extraction. A snapshot row
 * is still written every scan (append-only) so history stays intact.
 */

import { prisma } from '../prisma';
import { logger } from '../logger';
import type { TraversalScope, TraversedFile } from './types';

export interface DeltaCheck {
  shouldExtract: boolean;
  reason?: 'first_seen' | 'modified_since_last' | 'no_modified_time';
  skipReason?: 'delta_unchanged';
  lastScanAt?: Date;
  lastModifiedTime?: Date | null;
}

/**
 * Look up the most recent snapshot for a file and decide whether to extract.
 */
export async function checkDelta(file: TraversedFile): Promise<DeltaCheck> {
  if (!file.modifiedTime) {
    return { shouldExtract: true, reason: 'no_modified_time' };
  }
  const latest = await prisma.driveFileSnapshot.findFirst({
    where: { fileId: file.id },
    orderBy: { scannedAt: 'desc' },
    select: { scannedAt: true, modifiedTime: true },
  });
  if (!latest) {
    return { shouldExtract: true, reason: 'first_seen' };
  }
  const driveModified = new Date(file.modifiedTime);
  const previousModified = latest.modifiedTime;
  if (previousModified && driveModified <= previousModified) {
    return {
      shouldExtract: false,
      skipReason: 'delta_unchanged',
      lastScanAt: latest.scannedAt,
      lastModifiedTime: previousModified,
    };
  }
  return {
    shouldExtract: true,
    reason: 'modified_since_last',
    lastScanAt: latest.scannedAt,
    lastModifiedTime: previousModified,
  };
}

export interface WriteSnapshotInput {
  syncRunId: string | null;
  scope: TraversalScope;
  file: TraversedFile;
  wasExtracted: boolean;
  skipReason?: string | null;
  contentHash?: string | null;
}

/**
 * What the scan core (src/scan/process-batch.ts) knows about one file once
 * its worker has finished — the subset a snapshot row needs.
 */
export interface ScanOutcomeForSnapshot {
  file: TraversedFile;
  kind: 'skip' | 'error' | 'restricted' | 'ok';
  skipReason?: string;
  contentHash?: string;
}

/**
 * The snapshot row for one scan-core outcome.
 *
 * `skip_reason` reuses the v1 scanFolder vocabulary ('extract_error' for a
 * worker that threw, the extractor's own reason for a skip) plus
 * 'restricted' for a 403, which v1 had no branch for.
 *
 * `sync_run_id` is always null here. The v2 run id is a `drive_sync_runs`
 * row, but the column references `sync_runs` (the v1 table), so stamping the
 * queue's id fails the foreign key (23503) — that is how the scan core's
 * first writer ended up writing nothing.
 */
export function snapshotForScanOutcome(
  o: ScanOutcomeForSnapshot,
  scope: TraversalScope,
): WriteSnapshotInput {
  const base = { syncRunId: null, scope, file: o.file };
  switch (o.kind) {
    case 'ok':
      return { ...base, wasExtracted: true, contentHash: o.contentHash ?? null };
    case 'skip':
      return { ...base, wasExtracted: false, skipReason: o.skipReason ?? 'skipped' };
    case 'restricted':
      return { ...base, wasExtracted: false, skipReason: 'restricted' };
    case 'error':
      return { ...base, wasExtracted: false, skipReason: 'extract_error' };
  }
}

export async function writeSnapshot(input: WriteSnapshotInput): Promise<void> {
  const { file, scope } = input;
  await prisma.driveFileSnapshot.create({
    data: {
      syncRunId: input.syncRunId ?? null,
      fileId: file.id,
      accountId: scope.accountId,
      campaignId: scope.campaignId,
      name: file.name,
      mimeType: file.mimeType,
      path: file.path,
      modifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
      modifiedBy: file.modifiedByEmail,
      sizeBytes: file.size ? BigInt(file.size) : null,
      contentHash: input.contentHash ?? null,
      wasExtracted: input.wasExtracted,
      skipReason: input.skipReason ?? null,
    },
  });
}

/** Which writer failed: the scan core (processBatch) or the index catch-up. */
export type SnapshotWriteSource = 'scan' | 'refresh';

/**
 * The one place a failed drive_file_snapshots write is reported. Emits a
 * single WARN per row — the line the `drive_snapshot_write_failures` log-based
 * metric counts, so its message text is a contract — and returns a short
 * "code constraint" string for the human scan log.
 *
 * Ids and codes only, never the error's message: a Prisma validation error
 * prints the query arguments (file names, paths, editor emails).
 */
export function reportSnapshotWriteFailure(
  where: { fileId: string; accountId: string | null; source: SnapshotWriteSource },
  err: unknown,
): string {
  const { code, constraint } = describeWriteError(err);
  logger.warn(
    { fileId: where.fileId, accountId: where.accountId, source: where.source, code, constraint },
    '[drive.snapshot] write failed',
  );
  return constraint ? `${code} ${constraint}` : code;
}

/**
 * A Prisma request error carries `code` (P2003, …), an initialization error
 * `errorCode`; anything else is named by its class. Prisma 5 puts the violated
 * constraint of a P2003 in `meta.field_name`
 * ("drive_file_snapshots_sync_run_id_fkey (index)" on Postgres).
 */
function describeWriteError(err: unknown): { code: string; constraint: string | null } {
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const e = obj(err);
  const meta = obj(e['meta']);
  return {
    code: str(e['code']) ?? str(e['errorCode']) ?? str(e['name']) ?? 'unknown',
    constraint: str(meta['field_name']) ?? str(meta['constraint']),
  };
}
