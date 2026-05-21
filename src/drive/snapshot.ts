/**
 * drive.snapshot.ts — Per-file history + delta skip.
 *
 * Delta rule: if the most recent snapshot for this file_id has a modified_time
 * at or after Drive's current modifiedTime, we skip extraction. A snapshot row
 * is still written every scan (append-only) so history stays intact.
 */

import { prisma } from '../prisma';
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
