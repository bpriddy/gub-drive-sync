/**
 * content-gate.ts — skip interpret for a file whose prompt-visible content
 * did not change (#69, part c).
 *
 * Any non-delete Activity event makes the forward run re-extract and
 * re-interpret a file, and about half of those calls revisit a file seen
 * before. This module computes a content hash that covers exactly what the
 * interpret prompt depends on, so an unchanged file can skip the model.
 *
 * Two hash forms, both versioned by prefix:
 *   - "v2:" + sha256 of the prompt-visible text (the first
 *     GEMINI_MAX_INPUT_CHARS characters and whether the text was cut there),
 *     the file name, the folder path and the zone. Used for Google-native
 *     files, and for downloaded files that come without a content marker.
 *   - "bin:" + sha256 of Drive's md5Checksum (or `version` when there is no
 *     md5), the name, the path and the zone. Used for downloaded files
 *     (PDF, Office, text), and it is known BEFORE the download.
 *
 * What the hash leaves out, on purpose:
 *   - The modified time and editor. They are in the prompt, but they change
 *     on every edit, and an edit that changed nothing else is what this skips.
 *   - The count of characters cut off. The prompt states it, but an edit past
 *     the cut changes nothing the model reads.
 *   - The known-campaigns vocabulary and the entity states. They change for
 *     reasons unrelated to the file.
 *
 * Legacy hashes (v1 and pre-gate v2 rows store an md5 of the full text) never
 * equal either form. So the first pass after the flag turns on re-interprets
 * every file once, as expected.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma';
import type { EntityAttribution } from '../drive/structure';
import type { TraversedFile } from '../drive/types';
import { isDownloadedMime } from '../drive/extract';
import { promptFileText } from '../drive/prompt-text';

/** skip_reason of a file the gate skipped: content as at its last interpret. */
export const CONTENT_UNCHANGED_SKIP_REASON = 'content_unchanged';

/**
 * Where a file's observations go: account or campaign zone, and which
 * campaign and piece. A file that moves zone is re-interpreted even when its
 * name and path stayed the same (a folder newly classified as a campaign).
 */
export function contentZone(a: EntityAttribution): string {
  return JSON.stringify([a.ownerType, a.campaignFolderId, a.pieceFolderId, a.campaignName]);
}

function sha256(parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** The hash of an extracted file's prompt-visible text, name, path and zone. */
export function textContentHash(text: string, file: TraversedFile, zone: string): string {
  const { visible, truncated } = promptFileText(text);
  return `v2:${sha256([visible, truncated, file.name, file.path, zone])}`;
}

/**
 * The hash of a downloaded file from its Drive marker, before any download.
 * Null when the file is not downloaded (Google-native), is a shortcut (its
 * markers describe the shortcut, not the target) or has no marker.
 */
export function binaryContentHash(file: TraversedFile, zone: string): string | null {
  if (file.shortcutTarget || !isDownloadedMime(file.mimeType)) return null;
  const marker = file.md5Checksum
    ? `md5:${file.md5Checksum}`
    : file.version
      ? `version:${file.version}`
      : null;
  if (marker === null) return null;
  return `bin:${sha256([marker, file.name, file.path, zone])}`;
}

/** The hash to store on an extracted file's snapshot row. */
export function contentHashFor(file: TraversedFile, text: string, zone: string): string {
  return binaryContentHash(file, zone) ?? textContentHash(text, file, zone);
}

/**
 * When the account's last scan run completed: the gate only trusts snapshot
 * rows written by then (see loadLastExtractedHashes). Null before the first
 * completed run, which leaves the gate with nothing to match.
 */
export async function lastCompletedRunAt(accountId: string): Promise<Date | null> {
  const run = await prisma.driveSyncRun.findFirst({
    where: { accountId, status: 'completed', completedAt: { not: null } },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  });
  return run?.completedAt ?? null;
}
