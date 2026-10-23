/**
 * content-gate.ts — skip interpret for a file whose prompt-visible content
 * did not change (#69, part c).
 *
 * Any non-delete Activity event makes the forward run re-extract and
 * re-interpret a file, and about half of those calls revisit a file seen
 * before. This module computes a content hash that covers what the model
 * calls after the gate depend on, so an unchanged file can skip them.
 *
 * Two hash forms, both versioned by prefix and by GATE_EPOCH:
 *   - "v2:" + sha256 of the prompt-visible text (the first
 *     GEMINI_MAX_INPUT_CHARS characters and whether the text was cut there),
 *     the name, the folder path, the zone and whether the ideas tier runs.
 *     Used for Google-native files, shortcuts, and downloaded files that came
 *     without a content marker.
 *   - "bin:" + sha256 of Drive's content marker (md5Checksum, else
 *     headRevisionId, else version), GEMINI_MAX_INPUT_CHARS, the name, the
 *     path, the zone and the ideas flag. Used for downloaded files (PDF,
 *     Office, text), and it is known BEFORE the download.
 *
 * The ideas tier reads the WHOLE text (idea extraction has no 40k cut). When
 * it runs for the account, the "v2:" form also covers a digest of the full
 * text of a cut file, so an edit past the cut still reaches idea extraction.
 * Without the ideas tier, such an edit changes nothing a model reads.
 *
 * What the hash leaves out, on purpose:
 *   - The modified time and editor. They are in the prompt, but they change
 *     on every edit, and an edit that changed nothing else is what this skips.
 *   - The count of characters cut off. The prompt states it, but it changes
 *     nothing the model reads.
 *   - The known-campaigns vocabulary and the entity states. They change for
 *     reasons unrelated to the file.
 *   - The prompt preset, the model and the extractor version. A change to any
 *     of them re-interprets nothing by itself: bump GATE_EPOCH to force one
 *     full pass.
 *
 * Legacy hashes (v1 and pre-gate v2 rows store an md5 of the full text) never
 * equal either form. So the first pass after the flag turns on re-interprets
 * every file once, as expected.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma';
import { config } from '../config';
import type { EntityAttribution } from '../drive/structure';
import type { TraversedFile } from '../drive/types';
import { isDownloadedMime } from '../drive/extract';
import { promptFileText } from '../drive/prompt-text';

/** Bump to re-interpret every file once: a prompt, model or extractor change. */
export const GATE_EPOCH = 1;

/**
 * Where a file's observations go: account or campaign zone, the campaign
 * (its folder and, once matched, its row) and the piece. A file whose
 * observations would now go elsewhere is re-interpreted even when its name
 * and path stayed the same (a folder newly classified, a new campaign matched).
 */
export function contentZone(a: EntityAttribution): string {
  return JSON.stringify([
    a.ownerType,
    a.campaignFolderId,
    a.matchedCampaignId,
    a.campaignName,
    a.pieceId,
    a.pieceFolderId,
  ]);
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * The hash of an extracted file's prompt-visible text, name, path and zone.
 * `ideasOn`: the ideas tier runs for this account, so a cut file's full text
 * counts too.
 */
export function textContentHash(
  text: string,
  file: TraversedFile,
  zone: string,
  ideasOn: boolean,
): string {
  const { visible, truncated } = promptFileText(text);
  const fullText = ideasOn && truncated ? sha256(text) : null;
  return `v2:${sha256([GATE_EPOCH, visible, truncated, fullText, file.name, file.path, zone, ideasOn])}`;
}

/**
 * The hash of a downloaded file from its Drive marker, before any download.
 * Null when the file is not downloaded (Google-native), is a shortcut (its
 * markers describe the shortcut, not the target) or has no marker. md5 first:
 * it changes only with the bytes. headRevisionId next (a new content
 * revision). version last: it also grows on metadata changes, so it only
 * ever errs toward re-interpreting.
 */
export function binaryContentHash(
  file: TraversedFile,
  zone: string,
  ideasOn: boolean,
): string | null {
  if (file.shortcutTarget || !isDownloadedMime(file.mimeType)) return null;
  const marker = file.md5Checksum
    ? `md5:${file.md5Checksum}`
    : file.headRevisionId
      ? `rev:${file.headRevisionId}`
      : file.version
        ? `version:${file.version}`
        : null;
  if (marker === null) return null;
  return `bin:${sha256([
    GATE_EPOCH,
    marker,
    config.GEMINI_MAX_INPUT_CHARS,
    file.name,
    file.path,
    zone,
    ideasOn,
  ])}`;
}

/** The hash to store on an extracted file's snapshot row. */
export function contentHashFor(
  file: TraversedFile,
  text: string,
  zone: string,
  ideasOn: boolean,
): string {
  return binaryContentHash(file, zone, ideasOn) ?? textContentHash(text, file, zone, ideasOn);
}

/**
 * Margin under the cutoff for clock skew: drive_sync_runs.completed_at comes
 * from the job's clock, drive_file_snapshots.scanned_at from the database's.
 */
export const CUTOFF_SKEW_MS = 60_000;

/**
 * Up to when snapshot rows count as committed for the gate: the account's
 * last completed scan run, less CUTOFF_SKEW_MS. Rows written after it may come
 * from an attempt whose later stages failed (see loadLastExtractedHashes).
 * Null before the first completed run, which leaves the gate with nothing to
 * match.
 */
export async function gateCutoff(accountId: string): Promise<Date | null> {
  const run = await prisma.driveSyncRun.findFirst({
    where: { accountId, status: 'completed', completedAt: { not: null } },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  });
  return run?.completedAt ? new Date(run.completedAt.getTime() - CUTOFF_SKEW_MS) : null;
}
