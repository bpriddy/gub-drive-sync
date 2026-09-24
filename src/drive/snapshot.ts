/**
 * drive.snapshot.ts — Per-file history + delta skip.
 *
 * Delta rule: if the most recent snapshot for this file_id has a modified_time
 * at or after Drive's current modifiedTime, we skip extraction. A snapshot row
 * is still written every scan (append-only) so history stays intact.
 */

import { prisma } from '../prisma';
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
  // must not satisfy the delta rule. Spelled as an OR because Prisma's
  // `not` on a nullable column drops the NULL rows — every real scan row.
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
 * 'restricted' for a 403, which v1 had no branch for. `was_extracted` means
 * what GUB reads it as — content was extracted at this version — so an
 * `ok` outcome is extracted even when a later interpret or routing step
 * failed.
 */
export function snapshotForScanOutcome(
  o: ScanOutcomeForSnapshot,
  scope: TraversalScope,
  syncRunId: string | null,
): WriteSnapshotInput {
  const base = { syncRunId, scope, file: o.file };
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
