// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { log } from '../scan/output';
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
    log(`  ⚠ ${bogusBumped} file(s) had modifiedTime < createdTime — bumped to createdTime`);
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
    // RETURNING only the id: by default Prisma reads back every column,
    // drive_bootstrap_files included.
    select: { id: true },
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
  /**
   * ISO time of the last uncapped classify in CLASSIFY_DEPTH_CAP_MODE=auto
   * (the weekly full pass). Absent in `off` mode and before the first pass.
   */
  fullPassAt?: string;
}

/**
 * In-memory shape of the bootstrap files cache — what run.ts works with,
 * whatever the on-disk format. After decoding the current format every
 * DayBucket.files entry is the SAME object as its entry in `files`, so a
 * file costs one object in memory, not two.
 */
export interface BootstrapFilesCache {
  /** Full file list (modifiedTime + metadata) from chunk #1's discovery. */
  files: TraversedFile[];
  /** Pre-bucketed active days. Re-derivable from files but cheap to store. */
  activeDates: DayBucket[];
}

/**
 * On-disk shape of accounts.drive_bootstrap_files, version 2: each file is
 * stored ONCE, in `files`; a day lists the ids of its files.
 *
 * The first format (no `version` key, BootstrapFilesCacheV1) stored every
 * file twice — in `files` and again inside its day bucket — which doubled
 * the cache and reached PostgreSQL's jsonb ceiling (~255 MB) at roughly
 * 330-350k files. Version 2 halves the bytes per file, so about twice as
 * many files fit; a drive beyond that needs the cache out of the single
 * value (one row per chunk of files).
 */
export interface BootstrapFilesCacheV2 {
  version: 2;
  files: TraversedFile[];
  activeDates: Array<{ date: string; fileIds: string[] }>;
}

/**
 * Legacy on-disk shape (no `version` key): files stored twice. Still READ so
 * a bootstrap chain that started before version 2 keeps its cache across the
 * deploy; never written any more.
 */
export interface BootstrapFilesCacheV1 {
  files: TraversedFile[];
  activeDates: Array<{ date: string; files: TraversedFile[] }>;
}

export function structureFingerprint(
  folders: Array<{ id: string; name: string; parentId: string | null }>,
): string {
  // Sort by id for determinism, then JSON-stringify a minimal canonical
  // form. Same folders → same hash regardless of API return order.
  const canonical = folders
    .map((f) => ({ id: f.id, name: f.name, parentId: f.parentId }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function persistStructureCache(
  accountId: string,
  cache: StructureCache,
): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    // RETURNING only the id: by default Prisma reads back every column,
    // drive_bootstrap_files included.
    select: { id: true },
    data: {
      driveStructureClassification: cache as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * In-memory cache → on-disk version 2. Expects every file of every bucket to
 * be in `files` (groupFilesByDate(files) guarantees it): the decoder treats a
 * day that lists an id missing from `files` as a corrupt cache.
 */
export function encodeBootstrapFilesCache(cache: BootstrapFilesCache): BootstrapFilesCacheV2 {
  return {
    version: 2,
    files: cache.files,
    activeDates: cache.activeDates.map((d) => ({
      date: d.date,
      fileIds: d.files.map((f) => f.id),
    })),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * On-disk value → in-memory cache, or null for a cache miss. Reads version 2
 * and the legacy format. NULL / absent is the normal "no cache yet" state and
 * is a silent miss; any other value we cannot use (unknown version, wrong
 * shape, a day listing an id that is not in `files`) is also a miss — the
 * caller re-discovers and overwrites it — but logs why, because an unreadable
 * cache costs a full re-discovery and should not pass unnoticed.
 */
export function decodeBootstrapFilesCache(raw: unknown): BootstrapFilesCache | null {
  if (raw === null || raw === undefined) return null;
  const unusable = (reason: string): null => {
    log(`  ⚠ Files cache unusable (${reason}) — ignoring it, falling back to file discovery`);
    return null;
  };
  if (!isRecord(raw)) return unusable('not a JSON object');
  const { files, activeDates } = raw;
  if (!Array.isArray(files) || !Array.isArray(activeDates)) {
    return unusable('files or activeDates is missing');
  }
  // run.ts reads activeDates[0]; a cache with no day has nothing to resume from.
  if (activeDates.length === 0) return unusable('no active days');

  // No `version` key = the legacy format: each bucket carries its own file
  // objects, so the value already is the in-memory shape.
  if (raw.version === undefined) {
    for (let i = 0; i < activeDates.length; i++) {
      const d: unknown = activeDates[i];
      if (!isRecord(d) || typeof d.date !== 'string' || !Array.isArray(d.files)) {
        return unusable(`legacy format, malformed active day #${i}`);
      }
    }
    const legacy = raw as unknown as BootstrapFilesCacheV1;
    return { files: legacy.files, activeDates: legacy.activeDates };
  }

  if (raw.version !== 2) {
    const v = raw.version;
    return unusable(`unknown format version ${typeof v === 'number' ? v : typeof v}`);
  }
  const byId = new Map<string, TraversedFile>();
  for (let i = 0; i < files.length; i++) {
    const f: unknown = files[i];
    if (!isRecord(f) || typeof f.id !== 'string') return unusable(`file #${i} has no id`);
    byId.set(f.id, f as unknown as TraversedFile);
  }
  const days: DayBucket[] = [];
  for (let i = 0; i < activeDates.length; i++) {
    const d: unknown = activeDates[i];
    if (!isRecord(d) || typeof d.date !== 'string' || !Array.isArray(d.fileIds)) {
      return unusable(`malformed active day #${i}`);
    }
    const dayFiles: TraversedFile[] = [];
    let missing = 0;
    for (const id of d.fileIds as unknown[]) {
      const f = typeof id === 'string' ? byId.get(id) : undefined;
      if (f) dayFiles.push(f);
      else missing++;
    }
    if (missing > 0) return unusable(`active day #${i} lists ${missing} id(s) missing from files`);
    days.push({ date: d.date, files: dayFiles });
  }
  return { files: files as TraversedFile[], activeDates: days };
}

export async function persistBootstrapFilesCache(
  accountId: string,
  cache: BootstrapFilesCache,
): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    // RETURNING only the id: by default Prisma reads back every column,
    // drive_bootstrap_files included.
    select: { id: true },
    data: {
      driveBootstrapFiles: encodeBootstrapFilesCache(cache) as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * Read the files cache for a bootstrap chunk. Selects ONLY this column: it is
 * the one value on the account row that grows with the drive (~19 MiB at 26k
 * files), so loadEntity leaves it out and only the bootstrap path pays for it.
 */
export async function loadBootstrapFilesCache(
  accountId: string,
): Promise<BootstrapFilesCache | null> {
  const row = await prisma.account.findUnique({
    where: { id: accountId },
    select: { driveBootstrapFiles: true },
  });
  return decodeBootstrapFilesCache(row?.driveBootstrapFiles ?? null);
}
