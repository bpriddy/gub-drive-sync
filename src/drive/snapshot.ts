/**
 * drive.snapshot.ts — The Drive file index: per-file history + delta skip.
 *
 * drive_file_snapshots is APPEND-ONLY history, one row per processed file per
 * run. Writers only INSERT; nothing updates or deletes a row (the operator
 * modes merge-campaign-dupes and clear-account are the existing exceptions).
 * It is also the Drive file-name index GUB reads: file-name search takes the
 * latest row per file, the `_sources` / `_cited` lists the latest row with
 * was_extracted = true. docs/drive-file-index.md has the full picture.
 *
 * Two writers, and `was_extracted` does NOT mean the same in both:
 *   v1 (scanFolder, src/drive/sync.ts): true = the text was extracted. The
 *     interpret step runs afterwards in a callback that logs its own failure,
 *     so a rate-limited interpret still left the row true — and the delta
 *     rule below then never re-interpreted that file.
 *   v2 (the scan core, src/scan/process-batch.ts): true = the text was
 *     extracted AND the per-file interpret call returned. A failure of either
 *     is false with skip_reason 'extract_error'. Later stages (routing, ideas,
 *     distill, synthesis) never change the row; their failures are the runs'
 *     own gates.
 * content_hash is set exactly on the extracted rows. A consumer that needs
 * "interpreted" must read v2 rows only (they leave sync_run_id NULL — necessary,
 * not sufficient, see the doc) or accept v1's weaker meaning.
 *
 * A third, listing-only writer is the index catch-up (snapshot-refresh.ts): it
 * records what a Drive listing shows, never an extraction, so its rows are
 * was_extracted = false with skip_reason INDEX_REFRESH_SKIP_REASON.
 *
 * Delta rule (v1 only): if the most recent snapshot for this file_id has a
 * modified_time at or after Drive's current modifiedTime, we skip extraction.
 * A snapshot row is still written every scan (append-only) so history stays
 * intact. The catch-up's listing-only rows do not count: a listing says nothing
 * about which version was last extracted.
 */

import { prisma } from '../prisma';
import { logger } from '../logger';
import type { TraversalScope, TraversedFile } from './types';

/** skip_reason of the listing-only rows drive/snapshot-refresh.ts writes. */
export const INDEX_REFRESH_SKIP_REASON = 'index_refresh';

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
  // Rows from refresh-snapshots record a listing, not an extraction, so they
  // must not satisfy the delta rule. Spelled as an OR because Prisma's `not`
  // on a nullable column drops the NULL rows — every extracted row.
  const latest = await prisma.driveFileSnapshot.findFirst({
    where: {
      fileId: file.id,
      OR: [{ skipReason: null }, { skipReason: { not: INDEX_REFRESH_SKIP_REASON } }],
    },
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

const LOOKUP_CHUNK = 1000;

/**
 * The content hash on each file's latest EXTRACTED row written at or before
 * `notAfter`: what the unchanged-content gate compares against. One query per
 * 1000 ids, never a lookup per file. Files with no such row are absent.
 *
 * The cutoff keeps out rows from an attempt that has not committed. A forward
 * window whose later stage failed is retried (H2's window-commit gate), and
 * its first attempt has already written was_extracted rows with the new
 * hashes. Matching those would skip the very files whose observations the
 * failure lost.
 */
export async function loadLastExtractedHashes(
  fileIds: string[],
  notAfter: Date,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(fileIds)];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK);
    const rows = await prisma.$queryRaw<Array<{ fileId: string; contentHash: string | null }>>`
      SELECT DISTINCT ON (file_id)
             file_id AS "fileId", content_hash AS "contentHash"
        FROM drive_file_snapshots
       WHERE file_id = ANY(${chunk}::text[])
         AND was_extracted
         AND scanned_at <= ${notAfter}
       ORDER BY file_id, scanned_at DESC
    `;
    for (const r of rows) if (r.contentHash) out.set(r.fileId, r.contentHash);
  }
  return out;
}

export interface WriteSnapshotInput {
  /**
   * The `sync_runs` row of a v1 full sync. The column references that v1
   * table, so v2 writers leave it null: stamping a `drive_sync_runs` queue id
   * here fails the foreign key (23503).
   */
  syncRunId: string | null;
  scope: TraversalScope;
  file: TraversedFile;
  /**
   * v1: the text was extracted — interpretation may still have failed.
   * v2: the text was extracted AND the per-file interpret call returned.
   * See the file header.
   */
  wasExtracted: boolean;
  /** Why the file was not extracted; the vocabulary is in docs/drive-file-index.md. */
  skipReason?: string | null;
  /** Set exactly on extracted rows. */
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
