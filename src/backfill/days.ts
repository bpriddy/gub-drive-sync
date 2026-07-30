// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { log } from './output';
import type { TraversedFile } from '../drive/types';

// ── Cursor + date-grouping helpers ───────────────────────────────────────────
//
// Backfill scans by active day. A scan = one calendar-day bucket of files
// keyed by effective last-touch date — max(modifiedTime, createdTime) →
// YYYY-MM-DD (see groupFilesByDate). The cursor lives on `accounts.drive_bootstrap_cursor`
// — a dedicated DATE column written at the end of every scan regardless
// of synthesis output. Earlier the cursor was derived from `_edited_at:`
// lines on status_markdown, but zero-obs days (no synthesis → no persist)
// left no trace, so subsequent runs replayed the same days forever. See
// migration 20260602000000_account_drive_backfill_cursor.

/** Convert a Date (from a Prisma `@db.Date` column, UTC midnight) to YYYY-MM-DD. */
export function ymdFromDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

export interface DayBucket {
  /** YYYY-MM-DD */
  date: string;
  files: TraversedFile[];
}

/**
 * Group files by their effective last-touch date, sort ASC. Returns one
 * bucket per active day — days with zero files modified are not in the
 * result, so the walker naturally skips them.
 *
 * Effective last-touch date = max(modifiedTime, createdTime).
 * Reasoning:
 *   - modifiedTime is "the last edit" — should be >= createdTime.
 *   - When it's NOT (e.g., Drive returns 1970-01-01 or 1980-01-01 for
 *     files with corrupted metadata or weird import histories), the
 *     modifiedTime is bogus and createdTime is the truth.
 *   - Taking max() makes us robust to that: garbage-in-the-past gets
 *     pulled forward to the real createdTime; legitimate edits stay.
 *
 * v2 semantics:
 * - A file edited many times appears once, on the day of its most
 *   recent edit (or its createdTime, whichever is later).
 * - The day-walk processes files in chronological order; per-entity
 *   synthesis merges with prior status_markdown, so newer information
 *   naturally supersedes older as the cursor advances.
 * - Historical intermediate states aren't recoverable from Google's
 *   API anyway; this approximation is honest about what we know.
 */
export function groupFilesByDate(files: TraversedFile[]): DayBucket[] {
  const byDate = new Map<string, TraversedFile[]>();
  let bogusBumped = 0;
  for (const f of files) {
    const modified = f.modifiedTime ?? null;
    const created = f.createdTime ?? null;
    if (!modified && !created) continue;
    // max(modified, created) — string ISO 8601 timestamps compare correctly.
    let effective: string;
    if (modified && created) {
      if (modified < created) {
        bogusBumped++;
        effective = created;
      } else {
        effective = modified;
      }
    } else {
      effective = (modified ?? created)!;
    }
    const date = effective.slice(0, 10);
    const bucket = byDate.get(date);
    if (bucket) bucket.push(f);
    else byDate.set(date, [f]);
  }
  if (bogusBumped > 0) {
    log(
      `  ⚠ ${bogusBumped} file(s) had modifiedTime < createdTime — bumped to createdTime`,
    );
  }
  return Array.from(byDate.entries())
    .map(([date, files]) => ({ date, files }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Persist per-scan progress on the account row. Called at the end of
 * every chunk regardless of synthesis output. Two columns written in one
 * round-trip:
 *
 *   - drive_bootstrap_cursor → the modifiedTime calendar day this chunk
 *     just processed (DATE; advances the walker for the NEXT chunk)
 *   - drive_last_run_at      → wall-clock time the chunk completed
 *     (TIMESTAMPTZ; "how recently did we work on this account")
 *
 * Both are account-scoped — even when the chunk is `--campaign-id`, both
 * live on the parent account.
 *
 * When `setCompleted` is true (cursor caught up to today), also stamps
 * drive_bootstrap_completed_at — bootstrap is done, forward sync takes
 * over from here.
 */
export async function persistCursor(
  accountId: string,
  ymd: string,
  setCompleted = false,
): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    data: {
      driveBootstrapCursor: new Date(`${ymd}T00:00:00Z`),
      driveLastRunAt: new Date(),
      ...(setCompleted
        ? {
            driveBootstrapCompletedAt: new Date(),
            // Bootstrap is done — file list cache no longer useful. Free
            // the ~7-10MB JSONB. Structure classification stays for
            // forward sync to pick up.
            driveBootstrapFiles: Prisma.JsonNull,
          }
        : {}),
    },
  });
}

// ── Bootstrap chain cache ────────────────────────────────────────────────
//
// Shape stored in accounts.drive_structure_classification and
// accounts.drive_bootstrap_files. Chunk #1 in a bootstrap chain writes
// both; chunks 2..N read both and skip the ~5-min prelude.
//
// Fingerprint = hash of the canonical folder list. Forward sync reads
// the structure classification, re-gathers folders, hashes them again,
// and re-classifies only on mismatch.

export interface StructureCache {
  /** sha256 of sorted folder list + classifier prompt version + model id. */
  fingerprint: string;
  /** Persisted classifier output. */
  entityMap: unknown; // EntityMap shape from drive/structure module
  /** Snapshot of the folder list that produced the fingerprint. */
  folders: unknown;
  classifierPromptVersion?: string;
  classifierModelId?: string;
}

export interface BootstrapFilesCache {
  /** Full file list (modifiedTime + metadata) from chunk #1's discovery. */
  files: TraversedFile[];
  /** Pre-bucketed active days. Re-derivable from files but cheap to store. */
  activeDates: DayBucket[];
}

export function structureFingerprint(folders: Array<{ id: string; name: string; parentId: string | null }>): string {
  // Sort by id for determinism, then JSON-stringify a minimal canonical
  // form. Same folders → same hash regardless of API return order.
  const canonical = folders
    .map((f) => ({ id: f.id, name: f.name, parentId: f.parentId }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

export async function persistStructureCache(
  accountId: string,
  cache: StructureCache,
): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    data: {
      driveStructureClassification: cache as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function persistBootstrapFilesCache(
  accountId: string,
  cache: BootstrapFilesCache,
): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    data: {
      driveBootstrapFiles: cache as unknown as Prisma.InputJsonValue,
    },
  });
}
