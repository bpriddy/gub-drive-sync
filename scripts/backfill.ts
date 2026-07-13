/**
 * backfill.ts — single-day backfill runner.
 *
 * **One scan = one day of file CRUD.** Each invocation processes the
 * first activeDate strictly greater than the account's cursor and exits.
 * Walking multiple days = invoking N times (queue chains continuations
 * via gub-drive-sync/src/drive/backfill-queue.ts; CLI users loop
 * manually). Locked by design — see "Drive Sync: One Day Per Scan"
 * decision. The old `--all` / `--scans N` / wall-clock-budget knobs
 * were removed; the engine no longer loops across active days.
 *
 * Picks a paginated batch of files from an account's Drive folder, resolves
 * the folder→entity map, attributes each file to its owning entity,
 * extracts + distills observations per entity, synthesizes one
 * status_markdown per entity, and prints (and optionally persists)
 * everything.
 *
 * Two modes, controlled by --dryrun:
 *   - Default (no --dryrun): persist. Field guesses become entity-column
 *     updates; synthesized status_markdowns get written to the entity;
 *     new campaign candidates get CREATEd. All writes attributed to the
 *     Drive Sync system staff (no review queue — that's the design for
 *     backfill, where per-day human review is impractical).
 *   - --dryrun: preview only. Nothing is written to the DB. Use to
 *     inspect what would happen — observation routing, field guesses,
 *     synthesized status_markdowns — before committing.
 *
 * Each batch is INDEPENDENT — synthesis runs with prior_status = null
 * every time. Daily-snapshot timeline replay is a separate driver
 * (Stage 4) that loops this script over historical createdTime windows.
 *
 * Honest trade-off: per-file CONTENT is the file's CURRENT state, not
 * historical. We track revision METADATA (editor, timestamp) accurately,
 * but the LLM sees today's content. Acceptable proxy per the "creation-
 * order processing gives temporal evolution via processing order" model
 * for backfill; revision-content replay is a later refinement.
 *
 * Usage:
 *   npm run backfill -- --account-id <uuid>
 *     → Run the backfill. Writes entity columns + *_changes + new
 *       campaign rows. System-staff attribution.
 *
 *   npm run backfill -- --account-id <uuid> --dryrun
 *     → Preview only. Nothing written. Same flow, same logs, no DB
 *       changes — use to inspect what would happen before committing.
 *
 *   npm run backfill -- --account-id <uuid> --batch-size 100
 *     → First 100 files
 *
 *   npm run backfill -- --account-id <uuid> --batch 1
 *     → Files 31–60 (second batch of 30)
 *
 *   npm run backfill -- --account-id <uuid> --newest-first
 *     → Pick the LATEST active day past the cursor instead of the
 *       earliest. Same one-day semantics.
 *
 *   npm run backfill -- --account-id <uuid> --structure
 *     → Resolve + print the folder→entity map only. No extraction, no
 *       writes. Use to inspect the structure scan against a real tree.
 *
 * Flags:
 *   --account-id <uuid>  OR --campaign-id <uuid>  (exactly one)
 *   --newest-first       Pick the NEWEST active day past cursor; default
 *                        is OLDEST (which is what catchup wants).
 *   --output <path>      Tee all output to a file
 *   --structure          Account-only. Print the entity map and exit.
 *   --dryrun             Skip DB writes — preview only. Default is to
 *                        persist (system-staff attribution).
 */
import { writeFileSync, appendFileSync } from 'node:fs';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import {
  listRevisions,
  listSharedDriveFiles,
  probeFolder,
  type DriveRevisionMeta,
} from '../src/drive/client';
import { traverseFolder } from '../src/drive/traversal';
import { extractText, predictExtractionSkip } from '../src/drive/extract';
import { interpretFile, type AccountObservation, type CampaignObservation } from '../src/drive/interpret';
import {
  ACCOUNT_FIELD_WRITE,
  ACCOUNT_WRITABLE_FIELDS,
  CAMPAIGN_FIELD_WRITE,
  CAMPAIGN_WRITABLE_FIELDS,
  buildAccountCurrentState,
  buildCampaignCurrentState,
  isNoOpChange,
  validateProposedValue,
  type AccountCurrentState,
  type CampaignCurrentState,
  type ChangeValueKind,
  type FieldWriteSpec,
} from '../src/drive/schema';
import { distillationResponseSchema } from '../src/drive/structured-output';
import { summarizeError } from '../src/progress';
import { defaultLlm, parseLlmJson, runPreset } from '../src/ai';
import {
  accountFieldsAsMap,
  assembleSensitiveStatusMarkdown,
  assembleStatusMarkdown,
  campaignFieldsAsMap,
  extractContextSection,
  extractTransientSection,
  parseQuadContextOutput,
  pruneExpiredTransientBullets,
  renderAtAGlanceBullets,
  renderStatusSynthesisV1Prompt,
  STATUS_SYNTHESIS_V1_VERSION,
} from '../src/drive/status-synthesis';
import {
  buildAttributor,
  classifyFolders,
  gatherFolders,
  overlayPieceAnchors,
  type Attributor,
  type ClassifiedFolder,
  type EntityAttribution,
  type EntityMap,
  type FolderNode,
  type PieceAnchor,
} from '../src/drive/structure';
import { matchCampaignName } from '../src/drive/name-similarity';
import type { TraversedFile } from '../src/drive/types';
import { config } from '../src/config';

/**
 * System-staff UUID used as `changed_by` on every *_changes row written
 * during --apply mode. Seeded by migration 20260525100000. Same staff
 * used by the heal pipeline — backfill and heal share the "auto-applied
 * by the sync, no human in the loop" identity.
 */
const DRIVE_SYNC_SYSTEM_STAFF_ID = 'dcd5d8e3-0000-4000-a000-000000000001';

/**
 * Synthesized status_markdown for a NEW campaign candidate uses this
 * empty state for the at-a-glance bullets (no DB row exists yet).
 */
const EMPTY_CAMPAIGN_STATE: CampaignCurrentState = {
  status: null,
  budget: null,
  awarded_at: null,
  live_at: null,
  ends_at: null,
};

// ── Args ─────────────────────────────────────────────────────────────────────

export interface Args {
  accountId?: string;
  campaignId?: string;
  newestFirst: boolean;
  outputPath: string | null;
  /** Stage 1: resolve + print the structure entity map, then exit. */
  structureOnly: boolean;
  /**
   * --dryrun: preview only. Skip all DB writes; print what WOULD be
   * persisted. The default (no flag) is to actually run the backfill:
   * field_changes → entity columns, *_changes audit rows, status_markdown,
   * and CREATE for new campaign candidates. All writes attributed to the
   * Drive Sync system staff. No proposals, no review queue — that's the
   * backfill design (routing every historical day through human review
   * is impractical). Use --dryrun to inspect first; run without it to
   * commit.
   */
  dryrun: boolean;
  /**
   * Optional log-line capture buffer. When non-null, every log() line
   * is appended here in addition to stdout/outputFile. Used by the
   * `runBackfill` programmatic caller (gub-drive-sync's watch mode) to
   * persist a tail of the output as drive_backfill_requests.log_summary.
   * Not set from argv — populated by the caller.
   */
  captureLog?: string[];
}

export interface BackfillRunResult {
  /**
   * 0 or 1. Each invocation processes at most one active day (the first
   * activeDate strictly greater than the account's cursor). Locked by
   * design — see Drive Sync: One Day Per Scan decision.
   */
  scansProcessed: number;
  /** Files in this scan's day-bucket. Zero when scansProcessed=0. */
  filesProcessed: number;
  durationMs: number;
  /** Cursor at the end of the run, YYYY-MM-DD. Null if it stayed unchanged. */
  finalCursorYmd: string | null;
  /** Active-days range across the discovered file set. Null if no files. */
  activeDaysFirst: string | null;
  activeDaysLast: string | null;
  activeDaysCount: number;
  /** True if the run took the structureOnly early-exit path. */
  structureOnlyMode: boolean;
  /**
   * True when this chunk processed the last active day (cursor is now at
   * the most-recently-modified file's day) OR no active days remained at
   * the start of the chunk. Queue uses this to set
   * accounts.drive_bootstrap_completed_at and to stop the continuation
   * chain.
   */
  bootstrapCompleted: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const accountId = get('--account-id');
  const campaignId = get('--campaign-id');
  if ((accountId && campaignId) || (!accountId && !campaignId)) {
    throw new Error('Pass exactly one of --account-id or --campaign-id');
  }

  const out: Args = {
    newestFirst: has('--newest-first'),
    outputPath: get('--output') ?? null,
    structureOnly: has('--structure'),
    dryrun: has('--dryrun'),
  };
  if (accountId) out.accountId = accountId;
  if (campaignId) out.campaignId = campaignId;

  if (out.structureOnly && !accountId) {
    throw new Error('--structure requires --account-id (structure resolution is account-rooted)');
  }
  return out;
}

// ── Output ───────────────────────────────────────────────────────────────────

let outputFile: string | null = null;
/**
 * When non-null, every log() line is also pushed here (in addition to
 * stdout / outputFile). Used by `runBackfill`'s programmatic callers
 * (the watch mode) to capture output for persistence as
 * drive_backfill_requests.log_summary.
 */
let logCapture: string[] | null = null;
function log(line = ''): void {
  process.stdout.write(line + '\n');
  if (outputFile) appendFileSync(outputFile, line + '\n');
  if (logCapture) logCapture.push(line);
}

function rule(title: string): string {
  const head = `═══ ${title} `;
  const remaining = Math.max(3, 78 - head.length);
  return head + '═'.repeat(remaining);
}

function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

// ── Phase timing ─────────────────────────────────────────────────────────────
//
// Each invocation builds a flat map of {phase → cumulative ms}. The hot
// paths wrap their work with `await timed('phase', () => ...)`; the
// summary is printed as the LAST log block at end of runBackfill so it
// survives the 40-line `tailLogSummary` clip and lands in the gub-admin
// log_summary column. Reset at the top of every runBackfillInner.
//
// Used to answer "where is the 85 minutes going on a single 1-day scan."

class PhaseTimer {
  private totals = new Map<string, number>();
  add(phase: string, ms: number): void {
    this.totals.set(phase, (this.totals.get(phase) ?? 0) + ms);
  }
  summary(): { rows: Array<{ phase: string; ms: number; pct: number }>; totalMs: number } {
    const total = Array.from(this.totals.values()).reduce((s, v) => s + v, 0);
    const rows = Array.from(this.totals.entries())
      .map(([phase, ms]) => ({ phase, ms, pct: total > 0 ? (ms / total) * 100 : 0 }))
      .sort((a, b) => b.ms - a.ms);
    return { rows, totalMs: total };
  }
}

let phaseTimer: PhaseTimer | null = null;

async function timed<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  if (!phaseTimer) return fn();
  const start = Date.now();
  try {
    return await fn();
  } finally {
    phaseTimer.add(phase, Date.now() - start);
  }
}

/** Pretty-name table so phase keys render as human labels in the summary. */
const PHASE_LABELS: Record<string, string> = {
  setup: 'Setup (loadEntity)',
  structure_walk: 'Drive walk (folders)',
  structure_classify: 'Classify folders (LLM)',
  file_discovery: 'Discover files (Drive)',
  revisions_fetch: 'Revisions fetch (Drive)',
  extract_text: 'Extract text (per-file)',
  interpret_file: 'Interpret file (per-file LLM)',
  distill: 'Distill (per-entity LLM)',
  synthesis: 'Synthesize (per-entity LLM)',
  db_writes: 'DB writes (persistTarget)',
  persist_cursor: 'Persist cursor (DB)',
};

function printPhaseSummary(wallClockMs: number): void {
  if (!phaseTimer) return;
  const { rows, totalMs: instrumentedMs } = phaseTimer.summary();
  if (rows.length === 0) return;
  log('');
  log(rule('Phase timing (this scan)'));
  const labelWidth = Math.max(
    ...rows.map((r) => (PHASE_LABELS[r.phase] ?? r.phase).length),
  );
  const timeWidth = Math.max(...rows.map((r) => fmtMs(r.ms).length));
  for (const r of rows) {
    const label = (PHASE_LABELS[r.phase] ?? r.phase).padEnd(labelWidth);
    const t = fmtMs(r.ms).padStart(timeWidth);
    const barLen = Math.round(r.pct / 5); // 20-wide bar
    const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
    const pct = `${r.pct.toFixed(0)}%`.padStart(4);
    log(`  ${label}   ${t}   ${bar}  ${pct}`);
  }
  log('  ' + '─'.repeat(labelWidth + 3 + timeWidth + 3 + 20 + 2 + 4));
  log(`  ${'Instrumented total'.padEnd(labelWidth)}   ${fmtMs(instrumentedMs).padStart(timeWidth)}`);
  const untracked = wallClockMs - instrumentedMs;
  if (untracked > 0) {
    log(`  ${'Wall-clock total'.padEnd(labelWidth)}   ${fmtMs(wallClockMs).padStart(timeWidth)}   (un-instrumented: ${fmtMs(untracked)})`);
  } else {
    log(`  ${'Wall-clock total'.padEnd(labelWidth)}   ${fmtMs(wallClockMs).padStart(timeWidth)}`);
  }
}

// ── Concurrency helper ───────────────────────────────────────────────────────
//
// Worker-pool over an array. N workers race for the next index from a
// shared counter (race-safe because JS is single-threaded at await
// boundaries). Results land in the right slot by index, so the returned
// array preserves input order despite non-deterministic completion order.
//
// Used by processBatch's per-entity distill+synth+write loop. Each entity
// owns a discrete status_markdown row — workers never touch the same row,
// so parallel writes are safe. See SYNTH_CONCURRENCY in config.ts.
//
// The fn is responsible for its own try/catch — uncaught throws will
// propagate and reject the parent Promise.all, killing peer workers.
// Callers that need error-per-item isolation should wrap fn accordingly.

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ── Cursor + date-grouping helpers ───────────────────────────────────────────
//
// Backfill scans by active day. A scan = one calendar-day bucket of files
// (createdTime → YYYY-MM-DD). The cursor lives on `accounts.drive_backfill_cursor`
// — a dedicated DATE column written at the end of every scan regardless
// of synthesis output. Earlier the cursor was derived from `_edited_at:`
// lines on status_markdown, but zero-obs days (no synthesis → no persist)
// left no trace, so subsequent runs replayed the same days forever. See
// migration 20260602000000_account_drive_backfill_cursor.

/** Convert a Date (from a Prisma `@db.Date` column, UTC midnight) to YYYY-MM-DD. */
function ymdFromDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

interface DayBucket {
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
function groupFilesByDate(files: TraversedFile[]): DayBucket[] {
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
async function persistCursor(
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

interface StructureCache {
  /** sha256 of sorted folder list + classifier prompt version + model id. */
  fingerprint: string;
  /** Persisted classifier output. */
  entityMap: unknown; // EntityMap shape from drive/structure module
  /** Snapshot of the folder list that produced the fingerprint. */
  folders: unknown;
  classifierPromptVersion?: string;
  classifierModelId?: string;
}

interface BootstrapFilesCache {
  /** Full file list (modifiedTime + metadata) from chunk #1's discovery. */
  files: TraversedFile[];
  /** Pre-bucketed active days. Re-derivable from files but cheap to store. */
  activeDates: DayBucket[];
}

function structureFingerprint(folders: Array<{ id: string; name: string; parentId: string | null }>): string {
  // Sort by id for determinism, then JSON-stringify a minimal canonical
  // form. Same folders → same hash regardless of API return order.
  const canonical = folders
    .map((f) => ({ id: f.id, name: f.name, parentId: f.parentId }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

async function persistStructureCache(
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

async function persistBootstrapFilesCache(
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

// ── Entity ───────────────────────────────────────────────────────────────────

interface EntityCtx {
  type: 'account' | 'campaign';
  id: string;
  name: string;
  folderId: string;
  /**
   * The parent account id for both account- and campaign-scoped ctx —
   * the bootstrap cursor lives on `accounts.drive_bootstrap_cursor` and
   * is account-scoped regardless of which entity drove the chunk.
   */
  accountId: string;
  accountState: AccountCurrentState;
  accountName: string;
  campaignName: string | null;
  campaignState: CampaignCurrentState | null;
  /** Current persisted status_markdown (general) or null. */
  statusMarkdown: string | null;
  /** Current persisted status_sensitive_markdown or null (per D29). */
  statusSensitiveMarkdown: string | null;
  /**
   * Persisted `accounts.drive_bootstrap_cursor` as YYYY-MM-DD, or null.
   * Drives the modifiedTime-day walker's "next pending day" lookup.
   * Written at the end of every chunk regardless of synthesis output.
   */
  driveBootstrapCursor: string | null;
  /**
   * Cached structure (folders + entity_map + fingerprint) from a prior
   * chunk. NULL = first chunk in chain, or cache invalidated. Engine
   * checks fingerprint; on match, skips the ~1m 45s LLM classify step.
   */
  driveStructureClassification: unknown;
  /**
   * Cached file list + active_dates from bootstrap chunk #1. NULL after
   * bootstrap completes (or before first chunk). When present, chunks
   * 2..N skip the ~3 min file discovery + grouping step.
   */
  driveBootstrapFiles: unknown;
  reviewerEmail: string | null;
  reviewerStaffId: string | null;
}

async function loadEntity(args: Args): Promise<EntityCtx> {
  if (args.accountId) {
    const a = await prisma.account.findUniqueOrThrow({
      where: { id: args.accountId },
      include: { owner: { select: { id: true, email: true } } },
    });
    if (!a.driveFolderId) throw new Error(`Account ${a.name} has no drive_folder_id`);
    return {
      type: 'account',
      id: a.id,
      name: a.name,
      folderId: a.driveFolderId,
      accountId: a.id,
      accountState: buildAccountCurrentState(a),
      accountName: a.name,
      campaignName: null,
      campaignState: null,
      statusMarkdown: a.statusMarkdown ?? null,
      statusSensitiveMarkdown: a.statusSensitiveMarkdown ?? null,
      driveBootstrapCursor: ymdFromDate(a.driveBootstrapCursor),
      driveStructureClassification: a.driveStructureClassification,
      driveBootstrapFiles: a.driveBootstrapFiles,
      reviewerEmail: a.owner?.email ?? null,
      reviewerStaffId: a.owner?.id ?? null,
    };
  }
  const c = await prisma.campaign.findUniqueOrThrow({
    where: { id: args.campaignId! },
    include: { account: { include: { owner: { select: { id: true, email: true } } } } },
  });
  if (!c.driveFolderId) throw new Error(`Campaign ${c.name} has no drive_folder_id`);
  return {
    type: 'campaign',
    id: c.id,
    name: c.name,
    folderId: c.driveFolderId,
    accountId: c.account.id,
    accountState: buildAccountCurrentState(c.account),
    accountName: c.account.name,
    campaignName: c.name,
    campaignState: buildCampaignCurrentState(c),
    statusMarkdown: c.statusMarkdown ?? null,
    statusSensitiveMarkdown: c.statusSensitiveMarkdown ?? null,
    driveBootstrapCursor: ymdFromDate(c.account.driveBootstrapCursor),
    driveStructureClassification: c.account.driveStructureClassification,
    driveBootstrapFiles: c.account.driveBootstrapFiles,
    reviewerEmail: c.account.owner?.email ?? null,
    reviewerStaffId: c.account.owner?.id ?? null,
  };
}

// ── Phase 1: gather all files (no revisions yet) ────────────────────────────

async function gatherFilesAuto(
  folderId: string,
  label: string,
  newestFirst: boolean,
): Promise<TraversedFile[]> {
  const probe = await probeFolder(folderId);
  if (probe.isSharedDriveRoot && probe.driveId) {
    log(`  Folder type: shared drive root (driveId=${probe.driveId})`);
    log(`  Using FLAT list (orderBy=createdTime ${newestFirst ? 'desc' : 'asc'})…`);
    return listSharedDriveFiles(probe.driveId, {
      orderBy: newestFirst ? 'createdTime desc' : 'createdTime asc',
    });
  }
  log(`  Folder type: folder inside drive (driveId=${probe.driveId ?? 'My Drive'})`);
  log('  Using RECURSIVE walk…');
  return gatherFilesRecursive(folderId, label, newestFirst);
}

async function gatherFilesRecursive(
  folderId: string,
  label: string,
  newestFirst: boolean,
): Promise<TraversedFile[]> {
  const files: TraversedFile[] = [];
  let folderCount = 0;
  let subfolderErrors = 0;
  let depthCapHits = 0;
  let lastTick = Date.now();
  let lastPath = '';
  const isTTY = process.stdout.isTTY === true;
  const tick = (): void => {
    if (!isTTY) return;
    const now = Date.now();
    if (now - lastTick < 250) return;
    lastTick = now;
    const pathTail = lastPath.length > 40 ? '…' + lastPath.slice(-40) : lastPath;
    const line = `  Listing files…  ${files.length} files, ${folderCount} folders   ${pathTail}`;
    process.stdout.write('\r' + line.padEnd(100).slice(0, 100));
  };
  for await (const f of traverseFolder(folderId, label, {
    onFolderError: () => { subfolderErrors++; },
    onDepthCap: () => { depthCapHits++; },
  })) {
    if (f.isFolder) {
      folderCount++;
      lastPath = f.path;
    } else {
      files.push(f);
    }
    tick();
  }
  if (isTTY) process.stdout.write('\r' + ' '.repeat(100) + '\r');
  if (subfolderErrors > 0) log(`  ⚠ ${subfolderErrors} subfolder(s) unreadable (skipped)`);
  if (depthCapHits > 0) log(`  ⚠ ${depthCapHits} subfolder(s) past depth cap — files beneath NOT listed`);
  files.sort((a, b) => {
    const at = a.createdTime ? new Date(a.createdTime).getTime() : 0;
    const bt = b.createdTime ? new Date(b.createdTime).getTime() : 0;
    return newestFirst ? bt - at : at - bt;
  });
  return files;
}

// ── Per-batch processing ────────────────────────────────────────────────────

interface FileWithRevisions {
  file: TraversedFile;
  revisions: DriveRevisionMeta[];
}

interface CampaignBucket {
  campaignName: string;
  /**
   * Drive folder id for campaigns that have one (existing campaigns +
   * structure-discovered new candidates). NULL for phantom-name
   * candidates — where the per-file LLM emitted an entity_campaign_name
   * that didn't match any known campaign by exact or similarity match.
   * Those candidates become folder-less Campaign rows on persist.
   */
  campaignFolderId: string | null;
  campaignStatus: 'existing' | 'new';
  matchedCampaignId: string | null;
  /**
   * Origin of the bucket. Drives idempotency strategy at persist time:
   *   - 'folder'  → dedup by driveFolderId (existing path)
   *   - 'phantom' → dedup by case-insensitive name+accountId
   */
  bucketSource: 'folder' | 'phantom';
  observations: Array<{ observation: CampaignObservation; sourceFileId: string }>;
  fileIds: Set<string>;
}

/**
 * Name → bucket-routing hint built from the entity map. Used during
 * processBatch's per-file routing to resolve a tag (entity_campaign_name
 * emitted by the per-file LLM) to a concrete bucket key.
 */
interface CampaignNameDirectory {
  /** All campaign names known to the structure scan (existing + new), verbatim. */
  knownCampaignNames: string[];
  /** name (case-insensitive) → existing campaign db id */
  existingByName: Map<string, { campaignId: string; folderId: string; name: string }>;
  /** name (case-insensitive) → new-candidate folder id (from structure scan) */
  newFolderByName: Map<string, { folderId: string; name: string }>;
}

function buildCampaignNameDirectory(
  entityMap: EntityMap,
  existingCampaigns: Array<{ id: string; name: string; driveFolderId: string }>,
): CampaignNameDirectory {
  const existingByName = new Map<string, { campaignId: string; folderId: string; name: string }>();
  for (const c of existingCampaigns) {
    existingByName.set(c.name.trim().toLowerCase(), {
      campaignId: c.id,
      folderId: c.driveFolderId,
      name: c.name,
    });
  }
  const newFolderByName = new Map<string, { folderId: string; name: string }>();
  for (const cf of entityMap.classified) {
    if (cf.classification === 'new_campaign' && cf.campaignName) {
      newFolderByName.set(cf.campaignName.trim().toLowerCase(), {
        folderId: cf.folderId,
        name: cf.campaignName,
      });
    }
  }
  // Vocabulary the per-file LLM gets — union of existing + new-candidate names.
  const knownCampaignNames = [
    ...existingCampaigns.map((c) => c.name),
    ...entityMap.classified
      .filter((cf) => cf.classification === 'new_campaign' && !!cf.campaignName)
      .map((cf) => cf.campaignName!),
  ];
  return { knownCampaignNames, existingByName, newFolderByName };
}

/** Stage 3: per-entity distill+synth output, one entry per entity touched. */
interface EntitySynthesisResult {
  entityType: 'account' | 'campaign' | 'piece';
  entityName: string;
  /**
   * Status of the entity at synthesis time:
   * - 'account': it's the account itself.
   * - 'existing': existing campaign (matched to a DB row).
   * - 'new': new campaign candidate (no DB row yet — distill is skipped).
   */
  entityStatus: 'account' | 'existing' | 'new' | 'piece';
  observationsCount: number;
  filesCount: number;
  distillResult: {
    proposalsCreated: number;
    notesWritten: number;
    ambiguousWritten: number;
    driver: string;
  } | null;
  synthesizedMarkdown: string;
  /** Sensitive companion blob, null when no sensitive content this scan. */
  synthesizedSensitiveMarkdown: string | null;
  synthesisMs: number;
}

interface BatchOutcome {
  filesAttempted: number;
  filesExtracted: number;
  filesSkipped: number;
  filesErrored: number;
  filesZeroObs: number;
  accountObsTotal: number;
  campaignObsTotal: number;
  /** Stage 2: per-campaign observation breakdown (account scans only). */
  campaignBuckets: CampaignBucket[];
  /** Files attributed directly to the account (not inside any campaign). */
  accountLevelFiles: number;
  /** Campaign-bucket observations dropped because the file is account-level. */
  campaignObsDiscarded: number;
  /** Stage 3: one entry per entity that got distill+synth. */
  synthesized: EntitySynthesisResult[];
}

// ── Dry-run distillation helper (for new candidates) ────────────────────────
//
// New campaign candidates have no DB row yet, so distillAndEmit (which writes
// proposals) would violate the proposal CHECK constraint. But we still want
// the distillation LLM to extract field guesses from the bucketed
// observations — that's what turns a free-form note like "launch is
// September 5" into a structured `live_at = 2024-09-05` guess that should
// land in the at-a-glance bullets.
//
// This helper runs the same distillation prompt as production but DOES NOT
// write to the DB. The caller uses the resulting field_changes to populate
// the campaign's CurrentState for synthesis rendering. The integration with
// proposeNewEntity (so production new-entity proposals also carry these
// field guesses) is the Phase 7 / discover-refactor work — out of scope for
// the dry-run visibility fix.

const DryRunDistillationSchema = z.object({
  field_changes: z
    .array(
      z.object({
        field: z.string(),
        proposed_value: z.string().nullable().optional(),
        reasoning: z.string(),
        source_file_ids: z.array(z.string()).default([]),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  notes: z
    .array(
      z.object({
        text: z.string(),
        source_file_ids: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  ambiguous: z
    .array(
      z.object({
        text: z.string(),
        source_file_ids: z.array(z.string()).default([]),
        reasoning: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

async function runDryRunDistillation(
  entityType: 'account' | 'campaign',
  observations: Array<{
    observation: AccountObservation | CampaignObservation;
    sourceFileId: string;
  }>,
  currentState: AccountCurrentState | CampaignCurrentState,
): Promise<{
  field_changes: z.infer<typeof DryRunDistillationSchema>['field_changes'];
  notes: z.infer<typeof DryRunDistillationSchema>['notes'];
  driver: string;
}> {
  const observationsForPrompt = observations.map((o) => ({
    ...o.observation,
    source_file_id: o.sourceFileId,
  }));

  const completion = await runPreset({
    key: 'drive.distillation.v1',
    responseSchema: distillationResponseSchema(entityType),
    variables: {
      entity_type: entityType,
      writable_fields_json: JSON.stringify(
        entityType === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS,
      ),
      observations_json: JSON.stringify(observationsForPrompt, null, 2),
      current_state_json: JSON.stringify(currentState, null, 2),
    },
  });

  const parsed = parseLlmJson<unknown>(completion.text);
  const validated = DryRunDistillationSchema.parse(parsed);
  return {
    field_changes: validated.field_changes,
    notes: validated.notes,
    driver: completion.driver,
  };
}

// ── Apply helpers (cast + project to *_changes column shape) ─────────────────
//
// Mirrors gcp-universal-backend's drive.review.ts apply path so backfill
// produces audit rows + entity-column updates identical to what a reviewer
// approval would produce in forward sync. The only differences are
// changed_by (system staff here, reviewer there) and the lack of a
// drive_change_proposals row to reference.

function castToEntityValue(kind: ChangeValueKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'text':
      return typeof value === 'string' ? value : String(value);
    case 'uuid':
      return typeof value === 'string' ? value : String(value);
    case 'date': {
      const s = typeof value === 'string' ? value : String(value);
      return new Date(`${s}T00:00:00Z`);
    }
  }
}

function projectChangeRow(
  kind: ChangeValueKind,
  value: unknown,
  side: 'new' | 'previous',
): Record<string, string | Date | null> {
  const keyPrefix = side === 'new' ? 'value' : 'previousValue';
  const suffix = kind === 'text' ? 'Text' : kind === 'uuid' ? 'Uuid' : 'Date';
  const key = `${keyPrefix}${suffix}`;
  if (value === null || value === undefined) return { [key]: null };
  if (kind === 'date') {
    const s = typeof value === 'string' ? value : String(value);
    return { [key]: new Date(`${s}T00:00:00Z`) };
  }
  const s = typeof value === 'string' ? value : String(value);
  return { [key]: s };
}

interface ValidatedChange {
  field: string;
  spec: FieldWriteSpec;
  validatedValue: unknown;
  previousValue: unknown;
  /** Raw string form of proposed_value, used to populate state for synthesis. */
  proposedValueRaw: string | null;
  confidence: number;
}

/** Module-level Target type — used by both processBatch and persistTarget. */
interface PersistTarget {
  entityType: 'account' | 'campaign' | 'piece';
  entityName: string;
  entityStatus: 'account' | 'existing' | 'new' | 'piece';
  entityId: string | null;
  campaignFolderId: string | null;
  /**
   * Deterministic folder breadcrumb (FolderNode.path) for folder-backed
   * campaign targets; null for account / phantom targets. Persisted to
   * campaign.drive_folder_path so the merge's year gate can read the
   * structural year (the "… / 2026 / …" segment).
   */
  campaignFolderPath: string | null;
}

// ── Apply (persist) a single target's distilled + synthesized result ────────

async function persistTarget(args: {
  target: PersistTarget;
  ctx: EntityCtx;
  validatedChanges: ValidatedChange[];
  synthesizedMarkdown: string;
  synthesizedSensitiveMarkdown: string | null;
}): Promise<void> {
  const { target, ctx, validatedChanges, synthesizedMarkdown, synthesizedSensitiveMarkdown } = args;

  if (target.entityType === 'piece' && target.entityId) {
    await persistPieceTarget(target.entityId, synthesizedMarkdown, synthesizedSensitiveMarkdown);
    return;
  }
  if (target.entityType === 'account' && target.entityId) {
    await persistAccountTarget(
      target.entityId,
      validatedChanges,
      synthesizedMarkdown,
      synthesizedSensitiveMarkdown,
    );
    return;
  }
  if (target.entityType === 'campaign' && target.entityStatus === 'existing' && target.entityId) {
    await persistExistingCampaignTarget(
      target.entityId,
      validatedChanges,
      synthesizedMarkdown,
      synthesizedSensitiveMarkdown,
      target.campaignFolderPath,
    );
    return;
  }
  if (target.entityType === 'campaign' && target.entityStatus === 'new') {
    if (ctx.type !== 'account') {
      throw new Error('new campaign candidate requires account ctx');
    }
    // Guard: a folder that is already a PIECE of a merged campaign must never
    // be re-created as a campaign (the re-split bug). The piece-anchor overlay
    // routes these upstream, so this firing means attribution missed — prefer
    // NO write over a WRONG one: this target's synthesis was built with a null
    // prior, so writing it onto the owning campaign would clobber the
    // canonical's markdown. Skip and let the next scan route it correctly.
    if (target.campaignFolderId) {
      const piece = await prisma.campaignPiece.findFirst({
        where: { driveFolderId: target.campaignFolderId },
        select: { id: true, campaignId: true },
      });
      if (piece) {
        log(
          `      ⚠ folder ${target.campaignFolderId} is already piece ${piece.id} of campaign ${piece.campaignId} — skipping campaign create (overlay should have routed this)`,
        );
        return;
      }
    }
    // Idempotency: a campaign may already exist for this candidate. Two
    // dedup keys depending on bucket source:
    //   - Folder-backed candidates (structure scan): dedup by driveFolderId
    //   - Phantom-name candidates (campaignFolderId null): dedup by
    //     (accountId, name) case-insensitive — so a phantom obs that
    //     re-emerges on a later scan attaches to the same Campaign row.
    let alreadyCreated: { id: string } | null = null;
    if (target.campaignFolderId) {
      alreadyCreated = await prisma.campaign.findFirst({
        where: { driveFolderId: target.campaignFolderId },
        select: { id: true },
      });
    } else {
      alreadyCreated = await prisma.campaign.findFirst({
        where: {
          accountId: ctx.id,
          name: { equals: target.entityName, mode: 'insensitive' },
        },
        select: { id: true },
      });
    }
    if (alreadyCreated) {
      await persistExistingCampaignTarget(
        alreadyCreated.id,
        validatedChanges,
        synthesizedMarkdown,
        synthesizedSensitiveMarkdown,
        target.campaignFolderPath,
      );
      return;
    }
    await persistNewCampaignTarget({
      accountId: ctx.id,
      campaignName: target.entityName,
      driveFolderId: target.campaignFolderId,
      driveFolderPath: target.campaignFolderPath,
      validatedChanges,
      synthesizedMarkdown,
      synthesizedSensitiveMarkdown,
    });
    return;
  }
  throw new Error(`persistTarget: unsupported target shape (${target.entityType}/${target.entityStatus})`);
}

/**
 * Persist a piece's synthesized markdown. Pieces have no *_changes audit
 * table and no writable structured fields — markdown + last-run only.
 */
async function persistPieceTarget(
  pieceId: string,
  synthesizedMarkdown: string,
  synthesizedSensitiveMarkdown: string | null,
): Promise<void> {
  await prisma.campaignPiece.update({
    where: { id: pieceId },
    data: {
      statusMarkdown: synthesizedMarkdown,
      ...(synthesizedSensitiveMarkdown !== null
        ? { statusSensitiveMarkdown: synthesizedSensitiveMarkdown }
        : {}),
      driveLastRunAt: new Date(),
    },
  });
}

async function persistAccountTarget(
  accountId: string,
  validatedChanges: ValidatedChange[],
  synthesizedMarkdown: string,
  synthesizedSensitiveMarkdown: string | null,
): Promise<void> {
  const columnUpdates: Record<string, unknown> = {};
  for (const vc of validatedChanges) {
    columnUpdates[vc.spec.entityColumn] = castToEntityValue(vc.spec.changeKind, vc.validatedValue);
  }
  columnUpdates['statusMarkdown'] = synthesizedMarkdown;
  if (synthesizedSensitiveMarkdown !== null) {
    columnUpdates['statusSensitiveMarkdown'] = synthesizedSensitiveMarkdown;
  }

  await prisma.$transaction(async (tx) => {
    await tx.account.update({
      where: { id: accountId },
      data: columnUpdates,
    });
    for (const vc of validatedChanges) {
      const previousCols = projectChangeRow(vc.spec.changeKind, vc.previousValue, 'previous');
      const newCols = projectChangeRow(vc.spec.changeKind, vc.validatedValue, 'new');
      await tx.accountChange.create({
        data: {
          accountId,
          property: vc.field,
          ...previousCols,
          ...newCols,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
    await tx.accountChange.create({
      data: {
        accountId,
        property: 'status_markdown',
        valueText: synthesizedMarkdown,
        changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
      },
    });
    // Per D29: sensitive blob gets its own *_changes row so audit
    // history can be access-gated independently from the general blob.
    if (synthesizedSensitiveMarkdown !== null) {
      await tx.accountChange.create({
        data: {
          accountId,
          property: 'status_sensitive_markdown',
          valueText: synthesizedSensitiveMarkdown,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
  });
}

async function persistExistingCampaignTarget(
  campaignId: string,
  validatedChanges: ValidatedChange[],
  synthesizedMarkdown: string,
  synthesizedSensitiveMarkdown: string | null,
  /** Heals drive_folder_path on rows created before path plumbing existed.
   *  Only written when non-null — never clobbers a real path with null. */
  driveFolderPath?: string | null,
): Promise<void> {
  const columnUpdates: Record<string, unknown> = {};
  for (const vc of validatedChanges) {
    columnUpdates[vc.spec.entityColumn] = castToEntityValue(vc.spec.changeKind, vc.validatedValue);
  }
  columnUpdates['statusMarkdown'] = synthesizedMarkdown;
  if (synthesizedSensitiveMarkdown !== null) {
    columnUpdates['statusSensitiveMarkdown'] = synthesizedSensitiveMarkdown;
  }
  if (driveFolderPath) {
    columnUpdates['driveFolderPath'] = driveFolderPath;
  }

  await prisma.$transaction(async (tx) => {
    await tx.campaign.update({
      where: { id: campaignId },
      data: columnUpdates,
    });
    for (const vc of validatedChanges) {
      const previousCols = projectChangeRow(vc.spec.changeKind, vc.previousValue, 'previous');
      const newCols = projectChangeRow(vc.spec.changeKind, vc.validatedValue, 'new');
      await tx.campaignChange.create({
        data: {
          campaignId,
          property: vc.field,
          ...previousCols,
          ...newCols,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
    await tx.campaignChange.create({
      data: {
        campaignId,
        property: 'status_markdown',
        valueText: synthesizedMarkdown,
        changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
      },
    });
    if (synthesizedSensitiveMarkdown !== null) {
      await tx.campaignChange.create({
        data: {
          campaignId,
          property: 'status_sensitive_markdown',
          valueText: synthesizedSensitiveMarkdown,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
  });
}

async function persistNewCampaignTarget(args: {
  accountId: string;
  campaignName: string;
  /**
   * Drive folder id for structure-discovered candidates. NULL for
   * phantom-name candidates (per-file LLM emitted a name that didn't
   * exist in the structure scan). Folder-less rows can be linked to a
   * folder later if structure resolution discovers one matching by name.
   */
  driveFolderId: string | null;
  /**
   * Deterministic folder breadcrumb (FolderNode.path). Persisted so the
   * merge's year gate can read the structural year folder ("… / 2026 / …").
   * Null for phantom candidates.
   */
  driveFolderPath: string | null;
  validatedChanges: ValidatedChange[];
  synthesizedMarkdown: string;
  synthesizedSensitiveMarkdown: string | null;
}): Promise<void> {
  const {
    accountId,
    campaignName,
    driveFolderId,
    driveFolderPath,
    validatedChanges,
    synthesizedMarkdown,
    synthesizedSensitiveMarkdown,
  } = args;
  const initialFields: Record<string, unknown> = {};
  for (const vc of validatedChanges) {
    initialFields[vc.spec.entityColumn] = castToEntityValue(
      vc.spec.changeKind,
      vc.validatedValue,
    );
  }

  await prisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        ...initialFields,
        name: campaignName.trim(),
        accountId,
        createdBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        driveFolderId,
        driveFolderPath,
        statusMarkdown: synthesizedMarkdown,
        ...(synthesizedSensitiveMarkdown !== null
          ? { statusSensitiveMarkdown: synthesizedSensitiveMarkdown }
          : {}),
      },
    });
    await tx.campaignChange.create({
      data: {
        campaignId: created.id,
        property: 'status_markdown',
        valueText: synthesizedMarkdown,
        changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
      },
    });
    if (synthesizedSensitiveMarkdown !== null) {
      await tx.campaignChange.create({
        data: {
          campaignId: created.id,
          property: 'status_sensitive_markdown',
          valueText: synthesizedSensitiveMarkdown,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
  });
}

type RouteCampaignObsResult =
  | { kind: 'discard' }
  | {
      kind: 'matched';
      via: 'tag-exact' | 'tag-folder' | 'folder' | 'levenshtein';
      similarity: number;
      key: string;
      bucket: CampaignBucket;
    }
  | {
      kind: 'phantom';
      via: 'phantom';
      similarity: number;
      key: string;
      bucket: CampaignBucket;
    };

/**
 * Resolve a single campaign observation to its target bucket. Used by
 * processBatch on every campaign obs in an account-scoped scan (attributor
 * non-null). Returns:
 *   - { kind: 'matched' } — routed to an existing-campaign or new-folder
 *     bucket (via tag-match or folder attribution)
 *   - { kind: 'phantom' } — routed to a phantom-name bucket; persist
 *     creates a folder-less Campaign row
 *   - { kind: 'discard' } — file is account-level AND the obs has no
 *     tag (or tag matched nothing → and we DO open a phantom for that;
 *     "discard" only happens when there's literally no signal — no tag,
 *     no campaign folder)
 *
 * Tag (entity_campaign_name) takes precedence over folder attribution.
 * Same-bucket dedup happens at the caller via the bucket key.
 */
function routeCampaignObs(
  obs: CampaignObservation,
  attribution: EntityAttribution,
  dir: CampaignNameDirectory | null,
): RouteCampaignObsResult {
  // (a) Tag-routed
  const emittedName = (obs.entity_campaign_name ?? '').trim();
  if (dir && emittedName) {
    const match = matchCampaignName(emittedName, dir.knownCampaignNames);
    if (match) {
      const norm = match.matched.trim().toLowerCase();
      const ex = dir.existingByName.get(norm);
      if (ex) {
        return {
          kind: 'matched',
          via: match.via === 'exact' ? 'tag-exact' : 'levenshtein',
          similarity: match.similarity,
          key: `existing:${ex.campaignId}`,
          bucket: {
            campaignName: ex.name,
            campaignFolderId: ex.folderId,
            campaignStatus: 'existing',
            matchedCampaignId: ex.campaignId,
            bucketSource: 'folder',
            observations: [],
            fileIds: new Set(),
          },
        };
      }
      const nw = dir.newFolderByName.get(norm);
      if (nw) {
        return {
          kind: 'matched',
          via: match.via === 'exact' ? 'tag-folder' : 'levenshtein',
          similarity: match.similarity,
          key: `new:${nw.folderId}`,
          bucket: {
            campaignName: nw.name,
            campaignFolderId: nw.folderId,
            campaignStatus: 'new',
            matchedCampaignId: null,
            bucketSource: 'folder',
            observations: [],
            fileIds: new Set(),
          },
        };
      }
      // (match found but neither map has it — shouldn't happen since
      // knownCampaignNames is the union, but fall through to phantom
      // defensively.)
    }
    // No name match → phantom new candidate
    const normEmitted = emittedName.toLowerCase();
    return {
      kind: 'phantom',
      via: 'phantom',
      similarity: 0,
      key: `phantom:${normEmitted}`,
      bucket: {
        campaignName: emittedName,
        campaignFolderId: null,
        campaignStatus: 'new',
        matchedCampaignId: null,
        bucketSource: 'phantom',
        observations: [],
        fileIds: new Set(),
      },
    };
  }

  // (b) No tag → fall back to folder attribution
  if (attribution.ownerType === 'campaign' && attribution.campaignFolderId) {
    if (attribution.campaignStatus === 'existing' && attribution.matchedCampaignId) {
      return {
        kind: 'matched',
        via: 'folder',
        similarity: 1,
        key: `existing:${attribution.matchedCampaignId}`,
        bucket: {
          campaignName: attribution.campaignName ?? '(unnamed campaign)',
          campaignFolderId: attribution.campaignFolderId,
          campaignStatus: 'existing',
          matchedCampaignId: attribution.matchedCampaignId,
          bucketSource: 'folder',
          observations: [],
          fileIds: new Set(),
        },
      };
    }
    return {
      kind: 'matched',
      via: 'folder',
      similarity: 1,
      key: `new:${attribution.campaignFolderId}`,
      bucket: {
        campaignName: attribution.campaignName ?? '(unnamed campaign)',
        campaignFolderId: attribution.campaignFolderId,
        campaignStatus: attribution.campaignStatus ?? 'new',
        matchedCampaignId: attribution.matchedCampaignId,
        bucketSource: 'folder',
        observations: [],
        fileIds: new Set(),
      },
    };
  }

  // (c) Account-level file with no tag → no owner
  return { kind: 'discard' };
}

async function processBatch(
  batch: FileWithRevisions[],
  ctx: EntityCtx,
  attributor: Attributor | null,
  /**
   * Directory for subject-based campaign routing. Null when attributor
   * is null (campaign-scoped scan — no cross-campaign attribution).
   * Carries (a) the verbatim known campaign names passed to the per-
   * file LLM as the entity_campaign_name vocabulary, and (b) the
   * lookup tables used to resolve a matched name back to its bucket
   * key (existing campaignId or structure-discovered folderId).
   */
  nameDirectory: CampaignNameDirectory | null,
  /**
   * FolderNode.path by folder id (deterministic breadcrumb), from the
   * structure walk. Null when attributor is null. Used to stamp
   * campaign.drive_folder_path on newly created campaigns.
   */
  folderPathById: Map<string, string> | null,
  /**
   * Pieces of the SCANNED campaign (campaign-scoped runs only; null for
   * account scans). Used by regime-1 routing to bucket piece-tagged files
   * (file.pieceId, set at discovery) to their piece.
   */
  piecesById: Map<string, { name: string; driveFolderId: string }> | null,
  applyToDb: boolean,
  /**
   * The "as-of" date for this scan in YYYY-MM-DD form. Used to stamp the
   * synthesized status_markdown's edited_at header. For backfill this is
   * the day being processed (the file bucket's calendar day); for any
   * future forward-sync callers it'd be today's date.
   */
  editedAt: string,
): Promise<BatchOutcome> {
  log(`  Extracting + interpreting ${batch.length} file(s)…`);

  const accountBucket: Array<{ observation: AccountObservation; sourceFileId: string }> = [];
  // Per-campaign buckets, keyed by a synthetic bucket key:
  //   - "existing:<campaignId>"   — tag-routed OR folder-routed to a known existing campaign
  //   - "new:<folderId>"          — structure-discovered new candidate (folder-based)
  //   - "phantom:<normalizedName>" — LLM emitted entity_campaign_name with no name match
  // Only populated when attributor is non-null (account scan).
  const campaignBuckets = new Map<string, CampaignBucket>();
  // Legacy single campaign bucket — used when attributor is null (campaign
  // scans, or if structure hasn't been resolved for any reason).
  const legacyCampaignBucket: Array<{ observation: CampaignObservation; sourceFileId: string }> = [];
  // Per-piece buckets — files under a piece's folder bucket to the PIECE
  // (fine detail); their high-level rolls up to the owning campaign at
  // synthesis time (absorb-up). Keyed by pieceId. Populated in account scans
  // via attribution.pieceId (piece-anchor overlay) and in campaign scans via
  // file.pieceId (tagged at discovery when gathering piece folders).
  interface PieceBucket {
    pieceId: string;
    pieceName: string;
    campaignId: string;
    campaignName: string;
    pieceFolderId: string;
    observations: Array<{ observation: CampaignObservation; sourceFileId: string }>;
    fileIds: Set<string>;
  }
  const pieceBuckets = new Map<string, PieceBucket>();

  const editors = new Map<string, number>();

  let filesExtracted = 0;
  let filesSkipped = 0;
  let filesErrored = 0;
  let filesZeroObs = 0;
  let accountLevelFiles = 0;
  let campaignObsDiscarded = 0;
  /** Tagged campaign obs whose name didn't match anything known → routed into phantom buckets. */
  let phantomObsRouted = 0;
  /** Tagged campaign obs whose name fuzzy-matched (Levenshtein) to a known campaign — logged for visibility. */
  let fuzzyMatchedObs = 0;

  for (const { file, revisions } of batch) {
    // Tally editors from revisions metadata (works even if extraction fails)
    for (const r of revisions) {
      const e = r.editorEmail ?? '(unknown)';
      editors.set(e, (editors.get(e) ?? 0) + 1);
    }

    // Resolve attribution from the file's immediate parent folder.
    // Without structure (attributor=null), every file is attributed to the
    // scanned entity itself — preserves the legacy campaign-scan behavior.
    let attribution: EntityAttribution;
    if (attributor) {
      attribution = attributor(file.parents?.[0] ?? null);
    } else {
      attribution = {
        ownerType: ctx.type,
        campaignFolderId: ctx.type === 'campaign' ? ctx.folderId : null,
        campaignName: ctx.campaignName,
        matchedCampaignId: null,
        campaignStatus: ctx.type === 'campaign' ? 'existing' : null,
        pieceId: null,
        pieceName: null,
        pieceFolderId: null,
      };
    }

    // The per-file LLM gets the campaign context that owns THIS file (or
    // null for account-level files). This is the structural fix for the
    // attribution leakage — every campaign observation is now framed
    // against the right campaign name.
    const perFileCampaignName =
      attribution.ownerType === 'campaign' ? attribution.campaignName : null;

    try {
      const extraction = await timed('extract_text', () => extractText(file));
      if (extraction.kind !== 'ok') {
        const detail = extraction.detail ? ` (${extraction.detail})` : '';
        log(`    ⊘ ${file.name}  [${file.mimeType}]  skip: ${extraction.reason}${detail}`);
        filesSkipped++;
        continue;
      }

      const res = await timed('interpret_file', () =>
        interpretFile({
          file,
          text: extraction.text,
          accountName: ctx.accountName,
          accountCurrentState: ctx.accountState,
          campaignName: perFileCampaignName,
          campaignCurrentState: attribution.ownerType === 'campaign' ? ctx.campaignState : null,
          // Subject-routing vocabulary. The LLM picks entity_campaign_name
          // from this list when an obs's subject is a specific campaign;
          // a free-form name signals an unknown campaign to the
          // orchestrator's phantom bucket.
          knownCampaigns: nameDirectory?.knownCampaignNames ?? [],
        }),
      );

      const totalObs = res.account.length + res.campaign.length;
      const symbol = totalObs > 0 ? '✓' : '○';
      const attrLabel =
        attribution.ownerType === 'campaign'
          ? `→ "${attribution.campaignName ?? '(unnamed)'}"${attribution.campaignStatus === 'new' ? ' [NEW candidate]' : ''}`
          : '→ account-level';
      log(
        `    ${symbol} ${file.name}  [${extraction.extractor}, ${fmtBytes(extraction.text.length)}]  ${attrLabel}  → ${res.account.length} account + ${res.campaign.length} campaign obs  [${res.driver}]`,
      );
      if (totalObs === 0) filesZeroObs++;

      // Account obs always go to the account bucket regardless of where
      // the file lives — they describe the brand at large.
      for (const obs of res.account) {
        accountBucket.push({ observation: obs, sourceFileId: file.id });
      }

      // Campaign obs routing. Three regimes:
      //
      // (1) No attributor → campaign scan, single-entity scope. Everything
      //     goes into the legacy bucket — tag is ignored (the LLM is
      //     extracting against one campaign anyway).
      //
      // (2) Attributor + tag (entity_campaign_name set) → SUBJECT-BASED.
      //     Match the tag against the known-campaign vocabulary. On match,
      //     route to that bucket regardless of which folder the file lives
      //     in. On no match, open a phantom bucket keyed by normalized name
      //     — becomes a folder-less new-candidate Campaign on persist.
      //
      // (3) Attributor + no tag → FALLBACK to file-folder attribution. Files
      //     in campaign folders nest under that campaign. Account-level
      //     files have no owner; campaign obs are discarded (counted).
      if (!attributor) {
        // Regime 1 — piece-tagged files (gathered from a piece's folder in a
        // campaign-scoped scan) bucket to the piece; the rest to the campaign.
        for (const obs of res.campaign) {
          if (file.pieceId && piecesById?.has(file.pieceId)) {
            const info = piecesById.get(file.pieceId)!;
            let pb = pieceBuckets.get(file.pieceId);
            if (!pb) {
              pb = {
                pieceId: file.pieceId,
                pieceName: info.name,
                campaignId: ctx.id,
                campaignName: ctx.name,
                pieceFolderId: info.driveFolderId,
                observations: [],
                fileIds: new Set(),
              };
              pieceBuckets.set(file.pieceId, pb);
            }
            pb.observations.push({ observation: obs, sourceFileId: file.id });
            pb.fileIds.add(file.id);
            continue;
          }
          legacyCampaignBucket.push({ observation: obs, sourceFileId: file.id });
        }
      } else {
        for (const obs of res.campaign) {
          // Piece routing (account scans): the file lives under a piece's
          // folder. Fine detail buckets to the piece — UNLESS the obs's tag
          // names a DIFFERENT campaign than the piece's owner (genuine
          // cross-reference → subject routing wins below).
          if (attribution.pieceId && attribution.matchedCampaignId) {
            const tag = (obs.entity_campaign_name ?? '').trim().toLowerCase();
            const ownerName = (attribution.campaignName ?? '').trim().toLowerCase();
            const tagIsForeign = tag !== '' && tag !== ownerName;
            if (!tagIsForeign) {
              let pb = pieceBuckets.get(attribution.pieceId);
              if (!pb) {
                pb = {
                  pieceId: attribution.pieceId,
                  pieceName: attribution.pieceName ?? '(unnamed piece)',
                  campaignId: attribution.matchedCampaignId,
                  campaignName: attribution.campaignName ?? '(unnamed)',
                  pieceFolderId: attribution.pieceFolderId!,
                  observations: [],
                  fileIds: new Set(),
                };
                pieceBuckets.set(attribution.pieceId, pb);
              }
              pb.observations.push({ observation: obs, sourceFileId: file.id });
              pb.fileIds.add(file.id);
              continue;
            }
          }
          const routed = routeCampaignObs(obs, attribution, nameDirectory);
          if (routed.kind === 'discard') {
            campaignObsDiscarded += 1;
            continue;
          }
          if (routed.kind === 'phantom') phantomObsRouted += 1;
          if (routed.kind === 'matched' && routed.via === 'levenshtein') {
            fuzzyMatchedObs += 1;
            log(
              `      ↺ fuzzy match: "${obs.entity_campaign_name ?? '?'}" → "${routed.bucket.campaignName}" (sim ${routed.similarity.toFixed(2)})`,
            );
          }
          let bucket = campaignBuckets.get(routed.key);
          if (!bucket) {
            bucket = routed.bucket;
            campaignBuckets.set(routed.key, bucket);
          }
          bucket.observations.push({ observation: obs, sourceFileId: file.id });
          bucket.fileIds.add(file.id);
        }
        // Track account-level files for the summary (even if their obs
        // weren't discarded thanks to tag-routing).
        if (attribution.ownerType !== 'campaign') accountLevelFiles += 1;
      }

      filesExtracted++;
    } catch (err) {
      log(`    ✗ ${file.name}  ERROR: ${summarizeError(err)}`);
      filesErrored++;
    }
  }

  // Materialize campaign-bucket list for the outcome + summary printing.
  const campaignBucketsList: CampaignBucket[] = Array.from(campaignBuckets.values()).sort(
    (a, b) => b.observations.length - a.observations.length,
  );
  const campaignObsTotal =
    campaignBucketsList.reduce((sum, b) => sum + b.observations.length, 0) +
    legacyCampaignBucket.length;

  log(
    `  → Extracted OK: ${filesExtracted}  Skipped: ${filesSkipped}  Errored: ${filesErrored}  Zero obs: ${filesZeroObs}`,
  );
  log('');

  // ── Per-entity observation breakdown ───────────────────────────────────
  log('  ── Observation buckets ──');
  log(`    Account "${ctx.accountName}"  ·  ${accountBucket.length} obs`);
  if (attributor) {
    for (const b of campaignBucketsList) {
      const tag =
        b.campaignStatus === 'existing'
          ? 'existing'
          : b.bucketSource === 'phantom'
            ? 'NEW (phantom — no folder)'
            : 'NEW candidate';
      log(
        `    Campaign "${b.campaignName}"  (${tag})  ·  ${b.observations.length} obs across ${b.fileIds.size} file(s)`,
      );
    }
    if (campaignBucketsList.length === 0) {
      log('    (no campaign-attributed files in this batch)');
    }
    if (accountLevelFiles > 0) {
      log(
        `    Account-level files: ${accountLevelFiles}  ·  untagged campaign obs discarded: ${campaignObsDiscarded}`,
      );
    }
    if (phantomObsRouted > 0) {
      log(`    Phantom-name obs routed to new-candidate buckets: ${phantomObsRouted}`);
    }
    if (fuzzyMatchedObs > 0) {
      log(`    Fuzzy-matched obs (typo-corrected): ${fuzzyMatchedObs}`);
    }
  }

  for (const pb of pieceBuckets.values()) {
    log(`    Piece "${pb.pieceName}" (campaign "${pb.campaignName}")  ·  ${pb.observations.length} obs`);
  }
  if (legacyCampaignBucket.length > 0 && !attributor) {
    // Campaign scan: report the single bucket plainly.
    log(`    Campaign "${ctx.campaignName ?? ctx.name}"  ·  ${legacyCampaignBucket.length} obs`);
  }
  log('');

  // Editor breakdown (top 8)
  const sortedEditors = Array.from(editors.entries()).sort((a, b) => b[1] - a[1]);
  if (sortedEditors.length > 0) {
    log('  Editors (across all revisions of batch files):');
    for (const [email, count] of sortedEditors.slice(0, 8)) {
      log(`    ${email.padEnd(40)} ${count} rev${count === 1 ? '' : 's'}`);
    }
    if (sortedEditors.length > 8) log(`    … (+${sortedEditors.length - 8} more)`);
  }

  // ── Distillation (calls real distill.ts which would normally write to DB,
  // but we want to capture results without persisting). Trade-off: distill
  // currently writes proposals. For dryrun we want to RUN the prompt but
  // NOT persist. Simplest: call distill against the bucket but suppress
  // writes via a transaction rollback? Or just accept that this dryrun
  // does write proposals (and we live with the cleanup).
  //
  // For now: keep it pure dry-run by directly invoking the distillation
  // prompt here, not the DB-writing distillAndEmit. We get the same
  // classification output, just don't persist.
  // ── Stage 3: per-entity distill + synthesize ───────────────────────────
  //
  // For each entity that has a non-empty observation bucket: distill its
  // observations (skipped for NEW candidates — there's no DB row to attach
  // proposals to; that path lives in proposeNewEntity), then synthesize
  // its status_markdown.
  //
  // For account scans: account + each campaign bucket from Stage 2.
  // For campaign scans: just the scanned campaign (legacy single bucket).
  //
  // Each per-entity LLM call is small (operates on the bucket digest, not
  // file content), so N entities = N cheap calls, not N expensive
  // re-extractions. The file-extraction work above ran ONCE per file.

  interface Target {
    entityType: 'account' | 'campaign' | 'piece';
    entityName: string;
    entityStatus: 'account' | 'existing' | 'new' | 'piece';
    /** For piece targets: the owning campaign (absorb-up destination). */
    pieceCampaignId?: string | null;
    pieceCampaignName?: string | null;
    entityId: string | null; // null for new candidates; otherwise account or campaign id
    /** Campaign-root folder id. Set for both existing + new candidate targets. */
    campaignFolderId: string | null;
    /** Deterministic breadcrumb for the folder (see PersistTarget). */
    campaignFolderPath: string | null;
    accountState: AccountCurrentState;
    campaignState: CampaignCurrentState | null;
    /** Prior persisted status_markdown (general) — merge base for general tier. */
    priorStatusMarkdown: string | null;
    /** Prior persisted status_sensitive_markdown — merge base for sensitive tier. */
    priorSensitiveMarkdown: string | null;
    observations: Array<
      | { observation: AccountObservation; sourceFileId: string }
      | { observation: CampaignObservation; sourceFileId: string }
    >;
    fileIds: Set<string>;
  }

  const targets: Target[] = [];

  if (accountBucket.length > 0) {
    targets.push({
      entityType: 'account',
      entityName: ctx.accountName,
      entityStatus: 'account',
      entityId: ctx.type === 'account' ? ctx.id : null,
      campaignFolderId: null,
      campaignFolderPath: null,
      accountState: ctx.accountState,
      campaignState: null,
      priorStatusMarkdown: ctx.statusMarkdown,
      priorSensitiveMarkdown: ctx.statusSensitiveMarkdown,
      observations: accountBucket,
      fileIds: new Set(accountBucket.map((o) => o.sourceFileId)),
    });
  }

  if (attributor) {
    // Account scan with structure → per-campaign targets. Load full DB
    // rows for existing campaigns so distillation has the right current
    // state (no-op detection + writable-field comparison). Also pulls
    // their prior status_markdown so the merge-on-subsequent-scans path
    // can layer today's bullets on top of yesterday's.
    const existingIds = campaignBucketsList
      .filter((b): b is CampaignBucket & { matchedCampaignId: string } =>
        b.campaignStatus === 'existing' && !!b.matchedCampaignId,
      )
      .map((b) => b.matchedCampaignId);

    const existingRows =
      existingIds.length > 0
        ? await prisma.campaign.findMany({ where: { id: { in: existingIds } } })
        : [];
    const stateByCampaignId = new Map<string, CampaignCurrentState>(
      existingRows.map((c) => [c.id, buildCampaignCurrentState(c)]),
    );
    const statusMdByCampaignId = new Map<string, string | null>(
      existingRows.map((c) => [c.id, c.statusMarkdown ?? null]),
    );
    const sensitiveMdByCampaignId = new Map<string, string | null>(
      existingRows.map((c) => [c.id, c.statusSensitiveMarkdown ?? null]),
    );

    for (const bucket of campaignBucketsList) {
      if (bucket.observations.length === 0) continue;
      const campaignState =
        bucket.matchedCampaignId && stateByCampaignId.has(bucket.matchedCampaignId)
          ? stateByCampaignId.get(bucket.matchedCampaignId)!
          : EMPTY_CAMPAIGN_STATE;
      const priorStatusMarkdown =
        bucket.matchedCampaignId && statusMdByCampaignId.has(bucket.matchedCampaignId)
          ? statusMdByCampaignId.get(bucket.matchedCampaignId) ?? null
          : null;
      const priorSensitiveMarkdown =
        bucket.matchedCampaignId && sensitiveMdByCampaignId.has(bucket.matchedCampaignId)
          ? sensitiveMdByCampaignId.get(bucket.matchedCampaignId) ?? null
          : null;
      targets.push({
        entityType: 'campaign',
        entityName: bucket.campaignName,
        entityStatus: bucket.campaignStatus,
        entityId: bucket.matchedCampaignId,
        campaignFolderId: bucket.campaignFolderId,
        campaignFolderPath:
          bucket.campaignFolderId !== null
            ? folderPathById?.get(bucket.campaignFolderId) ?? null
            : null,
        accountState: ctx.accountState,
        campaignState,
        priorStatusMarkdown,
        priorSensitiveMarkdown,
        observations: bucket.observations,
        fileIds: bucket.fileIds,
      });
    }
  } else if (legacyCampaignBucket.length > 0) {
    // Campaign scan: one target, the scanned campaign.
    targets.push({
      entityType: 'campaign',
      entityName: ctx.campaignName ?? ctx.name,
      entityStatus: 'existing',
      entityId: ctx.id,
      campaignFolderId: ctx.folderId,
      campaignFolderPath: null,
      accountState: ctx.accountState,
      campaignState: ctx.campaignState ?? EMPTY_CAMPAIGN_STATE,
      priorStatusMarkdown: ctx.statusMarkdown,
      priorSensitiveMarkdown: ctx.statusSensitiveMarkdown,
      observations: legacyCampaignBucket,
      fileIds: new Set(legacyCampaignBucket.map((o) => o.sourceFileId)),
    });
  }

  // Piece targets — one per piece bucket with observations. Pieces are
  // markdown-only synthesis targets: no writable fields, no distillation,
  // prior markdown from the campaign_pieces row.
  const pieceBucketsList = Array.from(pieceBuckets.values());
  if (pieceBucketsList.length > 0) {
    const pieceRowsForTargets = await prisma.campaignPiece.findMany({
      where: { id: { in: pieceBucketsList.map((b) => b.pieceId) } },
      select: { id: true, statusMarkdown: true, statusSensitiveMarkdown: true },
    });
    const pieceRowById = new Map(pieceRowsForTargets.map((r) => [r.id, r]));
    for (const pb of pieceBucketsList) {
      if (pb.observations.length === 0) continue;
      const row = pieceRowById.get(pb.pieceId);
      targets.push({
        entityType: 'piece',
        entityName: pb.pieceName,
        entityStatus: 'piece',
        entityId: pb.pieceId,
        campaignFolderId: pb.pieceFolderId,
        campaignFolderPath: null,
        pieceCampaignId: pb.campaignId,
        pieceCampaignName: pb.campaignName,
        accountState: ctx.accountState,
        campaignState: null,
        priorStatusMarkdown: row?.statusMarkdown ?? null,
        priorSensitiveMarkdown: row?.statusSensitiveMarkdown ?? null,
        observations: pb.observations,
        fileIds: pb.fileIds,
      });
    }
  }

  const synthesized: EntitySynthesisResult[] = [];

  if (targets.length === 0) {
    log('  (no entities with observations — nothing to distill or synthesize)');
  } else {
    log(
      `  Distill + synthesize ${targets.length} entit${targets.length === 1 ? 'y' : 'ies'}…  (concurrency=${config.SYNTH_CONCURRENCY})`,
    );

    // Per-entity work is fully independent: each entity owns its own
    // status_markdown row (one per account, one per campaign), no two
    // workers touch the same row, and reads/writes don't cross. Worker
    // pool with bounded concurrency (config.SYNTH_CONCURRENCY, default 8)
    // — see helper + config docstrings for rate-limit + DB-pool sizing.
    //
    // Log lines from the worker body are buffered locally and flushed
    // as a single contiguous block when the worker finishes its entity.
    // JS is single-threaded at await boundaries, so the for-loop flush
    // can't be preempted by another worker — each entity's block is
    // atomic in the output, even though entity order may not match
    // input order.
    const synthesizeTarget = async (target: Target): Promise<EntitySynthesisResult> => {
      const lineBuffer: string[] = [];
      const wlog = (line = ''): void => {
        lineBuffer.push(line);
      };

      wlog('');
      const statusTag =
        target.entityStatus === 'account' ? 'account'
        : target.entityStatus === 'existing' ? 'existing campaign'
        : target.entityStatus === 'piece' ? `piece of "${target.pieceCampaignName ?? '?'}"`
        : 'NEW campaign candidate';
      wlog(`  • ${statusTag}: "${target.entityName}"  ·  ${target.observations.length} obs / ${target.fileIds.size} file(s)`);

      // ── Distill (uniform across all entity kinds; dry-run only) ────────
      // Every target — account, existing campaign, new candidate — runs the
      // same distillation prompt, and we apply the resulting field_changes
      // to the target's CurrentState so the synthesized at-a-glance bullets
      // reflect what the post-approval state WOULD look like (current
      // values + proposed updates layered on top). Otherwise the account's
      // at-a-glance shows empty fields even when distillation surfaced
      // structured proposals for them.
      //
      // No proposals get written to the DB — the dry-run is intentionally
      // dry. The production path will write proposals via distillAndEmit
      // (or the structure-driven proposeNewEntity for new candidates) when
      // backfill ships. Keeping the dry-run write-free eliminates the
      // proposal-cleanup chore and avoids surprising the reviewer with
      // dev-run proposals.
      let distillResult: EntitySynthesisResult['distillResult'] = null;
      let validatedChanges: ValidatedChange[] = [];
      if (target.entityType === 'piece') {
        // Pieces are markdown-only: no writable fields → nothing to distill.
        // Observations flow straight into synthesis below.
        wlog('      (piece — markdown-only; distillation skipped)');
      } else
      try {
        // Captured OUTSIDE the closure: property narrowing ('piece' excluded
        // by the guard above) doesn't propagate into callbacks.
        const distillEntityType: 'account' | 'campaign' =
          target.entityType === 'account' ? 'account' : 'campaign';
        const baseState =
          target.entityType === 'account'
            ? target.accountState
            : (target.campaignState ?? EMPTY_CAMPAIGN_STATE);
        const dry = await timed('distill', () =>
          runDryRunDistillation(
            distillEntityType,
            target.observations,
            baseState,
          ),
        );
        distillResult = {
          proposalsCreated: dry.field_changes.length,
          notesWritten: dry.notes.length,
          ambiguousWritten: 0,
          driver: dry.driver,
        };

        // Validate every proposed field, drop no-ops + invalids. Same
        // gates production review uses on approve — backfill mirrors
        // them so auto-applied state matches what a reviewer-approved
        // sync would produce.
        const writeSpecs =
          target.entityType === 'account'
            ? (ACCOUNT_FIELD_WRITE as Record<string, FieldWriteSpec>)
            : (CAMPAIGN_FIELD_WRITE as Record<string, FieldWriteSpec>);

        let invalidCount = 0;
        let noOpCount = 0;
        for (const fc of dry.field_changes) {
          const spec = writeSpecs[fc.field];
          if (!spec) {
            invalidCount += 1;
            continue;
          }
          const validation = validateProposedValue(
            target.entityType,
            fc.field,
            fc.proposed_value ?? null,
          );
          if (!validation.ok) {
            invalidCount += 1;
            wlog(`        ⚠ skip "${fc.field}": ${validation.reason}`);
            continue;
          }
          const currentValue =
            target.entityType === 'account'
              ? target.accountState[fc.field as keyof AccountCurrentState] ?? null
              : (target.campaignState ?? EMPTY_CAMPAIGN_STATE)[fc.field as keyof CampaignCurrentState] ?? null;
          if (isNoOpChange(target.entityType, fc.field, currentValue, validation.value)) {
            noOpCount += 1;
            continue;
          }
          validatedChanges.push({
            field: fc.field,
            spec,
            validatedValue: validation.value,
            previousValue: currentValue,
            proposedValueRaw: fc.proposed_value ?? null,
            confidence: fc.confidence,
          });
        }

        const verb = target.entityStatus === 'new' ? 'would propose' : 'would update';
        const persistTag = applyToDb ? '' : ' (dryrun — not persisted)';
        wlog(
          `      ${verb}: ${validatedChanges.length} field changes${invalidCount > 0 ? ` (${invalidCount} invalid)` : ''}${noOpCount > 0 ? ` (${noOpCount} no-op)` : ''}, ${dry.notes.length} notes  [${dry.driver}]${persistTag}`,
        );

        // Layer validated proposed values onto the rendering state so
        // synthesis sees the post-apply at-a-glance.
        if (target.entityType === 'account') {
          const populated: AccountCurrentState = { ...target.accountState };
          for (const vc of validatedChanges) {
            (populated as Record<string, string | null>)[vc.field] = vc.proposedValueRaw;
          }
          target.accountState = populated;
        } else {
          const populated: CampaignCurrentState = {
            ...(target.campaignState ?? EMPTY_CAMPAIGN_STATE),
          };
          for (const vc of validatedChanges) {
            (populated as Record<string, string | null>)[vc.field] = vc.proposedValueRaw;
          }
          target.campaignState = populated;
        }

        for (const vc of validatedChanges) {
          const val = vc.proposedValueRaw ?? '(null)';
          wlog(`        · ${vc.field} = ${val}  (${(vc.confidence * 100).toFixed(0)}%)`);
        }
      } catch (err) {
        wlog(`      distill failed: ${summarizeError(err)}`);
      }

      // ── Synthesize (dual-output: general + sensitive) ───────────────
      const synthStart = Date.now();
      let synthesizedMarkdown: string;
      let synthesizedSensitiveMarkdown: string | null = null;
      try {
        const approvedAdditionalUpdates = target.observations.map((o) => ({
          text: o.observation.text,
          source_file_ids: [o.sourceFileId],
          // No reviewer-set sensitive flag during backfill — LLM classifies
          // via the rubric in the prompt. Forward sync (when wired) will
          // populate this from the reviewer's per-item toggle.
        }));
        const atAGlanceMap =
          target.entityType === 'account'
            ? accountFieldsAsMap(target.accountState)
            : target.entityType === 'piece'
              ? { Name: target.entityName, Campaign: target.pieceCampaignName ?? '—' }
              : campaignFieldsAsMap(target.campaignState ?? EMPTY_CAMPAIGN_STATE);
        // Per D23: pre-prune expired transient bullets from prior blobs
        // BEFORE the LLM sees them. asOfDate = the scan day = editedAt.
        const priorGeneralTransient = pruneExpiredTransientBullets(
          extractTransientSection(target.priorStatusMarkdown ?? ''),
          editedAt,
        );
        const priorSensitiveTransient = pruneExpiredTransientBullets(
          extractTransientSection(target.priorSensitiveMarkdown ?? ''),
          editedAt,
        );

        const renderedPrompt = renderStatusSynthesisV1Prompt({
          entityType: target.entityType,
          entityName: target.entityName,
          parentContext:
            target.entityType === 'campaign'
              ? `account: ${ctx.accountName}`
              : target.entityType === 'piece'
                ? `campaign: ${target.pieceCampaignName ?? '?'} · account: ${ctx.accountName}`
                : null,
          // Merge per-tier × per-durability against prior bullets (D25 + D23).
          currentContextBullets: extractContextSection(target.priorStatusMarkdown ?? '') ?? null,
          currentSensitiveBullets: extractContextSection(target.priorSensitiveMarkdown ?? '') ?? null,
          currentGeneralTransientBullets: priorGeneralTransient,
          currentSensitiveTransientBullets: priorSensitiveTransient,
          scanDay: editedAt,
          atAGlanceJson: JSON.stringify(atAGlanceMap, null, 2),
          approvedFieldChangesJson: JSON.stringify([], null, 2),
          approvedAdditionalUpdatesJson: JSON.stringify(approvedAdditionalUpdates, null, 2),
        });
        const res = await timed('synthesis', () =>
          defaultLlm.complete({
            model: 'gemini-3.5-flash',
            temperature: 0.2,
            prompt: renderedPrompt,
            tag: `backfill.${STATUS_SYNTHESIS_V1_VERSION}`,
          }),
        );
        // Parse the quad-output. If delimiters are missing, the parser
        // gates the whole response as sensitive — safer than leaking.
        const parsed = parseQuadContextOutput(res.text);
        const bullets = renderAtAGlanceBullets({
          entityType: target.entityType,
          ...(target.entityType === 'account'
            ? { accountState: target.accountState }
            : target.entityType === 'piece'
              ? { pieceFields: { Name: target.entityName, Campaign: target.pieceCampaignName ?? '—' } }
              : { campaignState: target.campaignState ?? EMPTY_CAMPAIGN_STATE }),
        });
        synthesizedMarkdown = assembleStatusMarkdown({
          editedAt,
          bullets,
          contextProse: parsed.generalContext,
          transientProse: parsed.generalTransient,
        });
        synthesizedSensitiveMarkdown =
          parsed.sensitiveContext || parsed.sensitiveTransient
            ? assembleSensitiveStatusMarkdown({
                editedAt,
                contextProse: parsed.sensitiveContext,
                transientProse: parsed.sensitiveTransient,
              })
            : null;
      } catch (err) {
        synthesizedMarkdown = `(synthesis failed: ${summarizeError(err)})`;
      }
      const synthesisMs = Date.now() - synthStart;
      wlog(
        `      synthesized in ${fmtMs(synthesisMs)}${synthesizedSensitiveMarkdown ? ' (general + sensitive)' : ''}`,
      );

      // ── Apply (when --apply is set) ─────────────────────────────────
      if (applyToDb) {
        try {
          await timed('db_writes', () =>
            persistTarget({
              target,
              ctx,
              validatedChanges,
              synthesizedMarkdown,
              synthesizedSensitiveMarkdown,
            }),
          );
          wlog('      ✓ applied (system-staff attribution)');
        } catch (err) {
          wlog(`      apply failed: ${summarizeError(err)}`);
        }
      }

      // Flush this entity's buffered log lines as one atomic block.
      // Synchronous calls to log() — no await between them — so another
      // worker can't interleave its flush in the middle of ours.
      for (const line of lineBuffer) log(line);

      return {
        entityType: target.entityType,
        entityName: target.entityName,
        entityStatus: target.entityStatus,
        observationsCount: target.observations.length,
        filesCount: target.fileIds.size,
        distillResult,
        synthesizedMarkdown,
        synthesizedSensitiveMarkdown,
        synthesisMs,
      };
    };

    // ── Two-phase walk: pieces FIRST, then account/campaigns ─────────────
    // A piece's high-level rolls up into its owning campaign's synthesis in
    // the SAME scan (absorb-up), so pieces must finish before campaigns start.
    const pieceTargets = targets.filter((t) => t.entityType === 'piece');
    const mainTargets = targets.filter((t) => t.entityType !== 'piece');

    const pieceResults =
      pieceTargets.length > 0
        ? await runWithConcurrency(pieceTargets, config.SYNTH_CONCURRENCY, synthesizeTarget)
        : [];

    // Absorb-up: one rollup bullet per piece, injected into the owning
    // campaign target through the SAME channel as any approved bullet — the
    // campaign synthesis dedupes/supersedes it like everything else. The
    // stable source id `piece:<id>` keys supersession across re-runs.
    // When the campaign has no direct obs this scan (piece-only day), a
    // campaign target is CREATED so the rollup merges into the campaign's
    // prior markdown NOW — a later scan won't have this piece's synthesis
    // in hand, so deferring would drop the rollup.
    for (let i = 0; i < pieceTargets.length; i++) {
      const pt = pieceTargets[i]!;
      const pr = pieceResults[i];
      if (!pr || !pt.pieceCampaignId) continue;
      const contextLines = (extractContextSection(pr.synthesizedMarkdown) ?? '')
        .split('\n')
        .map((l) => l.replace(/^-\s?/, '').trim())
        .filter(Boolean);
      const lead = contextLines[0];
      if (!lead) continue;
      let campaignTarget = mainTargets.find(
        (t) => t.entityType === 'campaign' && t.entityId === pt.pieceCampaignId,
      );
      if (!campaignTarget) {
        const row = await prisma.campaign.findUnique({ where: { id: pt.pieceCampaignId } });
        if (!row) continue;
        campaignTarget = {
          entityType: 'campaign',
          entityName: row.name,
          entityStatus: 'existing',
          entityId: row.id,
          campaignFolderId: row.driveFolderId,
          campaignFolderPath: null,
          accountState: ctx.accountState,
          campaignState: buildCampaignCurrentState(row),
          priorStatusMarkdown: row.statusMarkdown ?? null,
          priorSensitiveMarkdown: row.statusSensitiveMarkdown ?? null,
          observations: [],
          fileIds: new Set(),
        };
        mainTargets.push(campaignTarget);
      }
      campaignTarget.observations.push({
        observation: { text: `Piece "${pt.entityName}": ${lead}` } as CampaignObservation,
        sourceFileId: `piece:${pt.entityId}`,
      });
      log(`  ↑ absorb-up: piece "${pt.entityName}" → campaign "${campaignTarget.entityName}"`);
    }

    const mainResults =
      mainTargets.length > 0
        ? await runWithConcurrency(mainTargets, config.SYNTH_CONCURRENCY, synthesizeTarget)
        : [];

    synthesized.push(...pieceResults, ...mainResults);
  }

  return {
    filesAttempted: batch.length,
    filesExtracted,
    filesSkipped,
    filesErrored,
    filesZeroObs,
    accountObsTotal: accountBucket.length,
    campaignObsTotal,
    campaignBuckets: campaignBucketsList,
    accountLevelFiles,
    campaignObsDiscarded,
    synthesized,
  };
}

// ── Stage 1: structure-only ──────────────────────────────────────────────────

async function runStructureOnly(ctx: EntityCtx): Promise<void> {
  const existingCampaigns = (
    await prisma.campaign.findMany({
      where: { accountId: ctx.id, driveFolderId: { not: null } },
      select: { id: true, name: true, driveFolderId: true },
    })
  )
    .filter((c): c is { id: string; name: string; driveFolderId: string } => !!c.driveFolderId)
    .map((c) => ({ id: c.id, name: c.name, driveFolderId: c.driveFolderId }));

  log(`  Existing campaigns in DB: ${existingCampaigns.length}`);
  for (const c of existingCampaigns) {
    log(`    - ${c.name}  (folder ${c.driveFolderId})`);
  }
  log('');

  // ── Gather folders (with live progress) ─────────────────────────────────
  log('  Gathering folders…');
  const isTTY = process.stdout.isTTY === true;
  let lastTick = Date.now();
  const folders = await gatherFolders(ctx.folderId, ctx.name, {
    onProgress: (n) => {
      if (!isTTY) return;
      if (Date.now() - lastTick < 150) return;
      lastTick = Date.now();
      process.stdout.write('\r' + `    …${n} folders so far`.padEnd(40));
    },
  });
  if (isTTY) process.stdout.write('\r' + ' '.repeat(40) + '\r');
  log(`  Gathered ${folders.length} folders.`);
  log('');

  // ── Print the tree (so the structure is visible before classification) ──
  printFolderTree(folders);
  log('');

  // ── Classify ────────────────────────────────────────────────────────────
  log('  Classifying with LLM…');
  const started = Date.now();
  const map: EntityMap = await classifyFolders({
    accountId: ctx.id,
    accountName: ctx.name,
    rootFolderId: ctx.folderId,
    folders,
    existingCampaigns,
  });
  const elapsed = Date.now() - started;
  log('');

  printEntityMap(map);
  log('');
  log(rule(`Structure resolved in ${fmtMs(elapsed)}  [${map.driver}]`));
  log('');
}

function printFolderTree(folders: FolderNode[]): void {
  log(`  ── Folder tree (${folders.length} folders) ──`);
  for (const f of folders) {
    const indent = '  '.repeat(f.depth);
    log(`    ${indent}${f.name}/`);
  }
}

function printEntityMap(map: EntityMap): void {
  log(`  Folders walked: ${map.folderCount}`);
  log(`  Classified entries: ${map.classified.length}`);
  log('');

  const byClass = (c: ClassifiedFolder['classification']): ClassifiedFolder[] =>
    map.classified.filter((f) => f.classification === c);

  const existing = byClass('existing_campaign');
  const fresh = byClass('new_campaign');
  const acct = byClass('account_level');

  const section = (title: string, rows: ClassifiedFolder[]): void => {
    log(`  ── ${title} (${rows.length}) ──`);
    if (rows.length === 0) {
      log('    (none)');
    }
    for (const f of rows) {
      const label = f.campaignName ? `"${f.campaignName}"` : '';
      const matched = f.matchedCampaignId ? `  → campaignId ${f.matchedCampaignId}` : '';
      log(`    ${label ? label + '  ' : ''}${f.folderPath}${matched}`);
      log(`        [id ${f.folderId}]`);
      log(`        ${f.reasoning}`);
    }
    log('');
  };

  section('EXISTING CAMPAIGNS', existing);
  section('NEW CAMPAIGN CANDIDATES', fresh);
  section('ACCOUNT-LEVEL', acct);
}

// ── Main ─────────────────────────────────────────────────────────────────────
//
// The backfill engine is exported as runBackfill() so programmatic callers
// (gub-drive-sync's watch mode) can drive it directly without shelling out.
// The CLI main() below is a thin wrapper: parse argv → set outputFile →
// runBackfill → exit.

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.outputPath) {
    outputFile = args.outputPath;
    writeFileSync(outputFile, '');
  }
  await runBackfill(args);
}

/**
 * Programmatic entry point for the backfill engine. Same behavior as the
 * CLI, but returns a structured result for queue-driven callers. When
 * args.captureLog is provided, every log() line is appended there in
 * addition to stdout — the watcher uses this to persist a tail as the
 * request's log_summary.
 *
 * Caller is responsible for prisma.$disconnect() (this function shares
 * the singleton; the watcher disconnects on its own shutdown).
 */
export async function runBackfill(args: Args): Promise<BackfillRunResult> {
  const prevCapture = logCapture;
  if (args.captureLog) logCapture = args.captureLog;
  try {
    return await runBackfillInner(args);
  } finally {
    logCapture = prevCapture;
  }
}

async function runBackfillInner(args: Args): Promise<BackfillRunResult> {
  const overallStart = Date.now();
  const emptyResult = (): BackfillRunResult => ({
    scansProcessed: 0,
    filesProcessed: 0,
    durationMs: Date.now() - overallStart,
    finalCursorYmd: null,
    activeDaysFirst: null,
    activeDaysLast: null,
    activeDaysCount: 0,
    structureOnlyMode: false,
    bootstrapCompleted: false,
  });

  // Fresh phase timer for this invocation. Reset between back-to-back
  // CLI runs in the same process; queue mode spawns one process per
  // request so it's effectively per-row.
  phaseTimer = new PhaseTimer();

  // Heap watcher — emits a [mem] line every 30s with rss/heap/external
  // so OOM diagnostics survive even though the phase-summary block
  // can't print after SIGKILL. Cloud Run kills on rss exceeding the
  // Job's --memory limit; logging rss correlates directly.
  //
  // .unref() so the interval doesn't keep the event loop alive past
  // the scan's natural completion — we never need to clearInterval.
  setInterval(() => {
    const m = process.memoryUsage();
    const mb = (n: number): number => Math.round(n / 1024 / 1024);
    log(
      `  [mem] rss=${mb(m.rss)}MB  heapUsed=${mb(m.heapUsed)}MB  heapTotal=${mb(m.heapTotal)}MB  external=${mb(m.external)}MB`,
    );
  }, 30_000).unref();

  log('');
  log(rule(args.dryrun ? 'Backfill (dryrun — no DB writes)' : 'Backfill'));

  const ctx = await timed('setup', () => loadEntity(args));
  log(`  Entity: ${ctx.type}: ${ctx.name}  (${ctx.id})`);
  log(`  Folder: ${ctx.folderId}`);

  // Pieces of the scanned campaign (campaign scans only). Their folders are
  // part of the campaign's content — often SIBLINGS of the campaign root
  // (merged-variant folders) — so discovery gathers them too, tagging each
  // file with its piece. Account scans resolve pieces via the attributor's
  // piece-anchor overlay instead.
  const ctxPieceRows =
    ctx.type === 'campaign'
      ? await prisma.campaignPiece.findMany({
          where: { campaignId: ctx.id },
          select: { id: true, name: true, driveFolderId: true },
        })
      : [];
  const piecesById = new Map(
    ctxPieceRows
      .filter((p): p is typeof p & { driveFolderId: string } => !!p.driveFolderId)
      .map((p) => [p.id, { name: p.name, driveFolderId: p.driveFolderId }]),
  );
  if (piecesById.size > 0) {
    log(`  Pieces: ${piecesById.size} (folders gathered with the campaign)`);
  }

  // ── Stage 1: structure-only mode ──────────────────────────────────────────
  // Resolve + print the entity map, then exit. No file extraction. This is
  // the isolated validation surface for the structure read — eyeball the
  // map against the real tree before any of it drives attribution.
  if (args.structureOnly) {
    log('');
    log(rule('Structure resolution (Stage 1 — map only, no extraction)'));
    await runStructureOnly(ctx);
    return { ...emptyResult(), structureOnlyMode: true };
  }

  log(`  Sort: createdTime ${args.newestFirst ? 'DESC (newest first)' : 'ASC (oldest first)'}`);
  log('');

  // ── Stage 2: structure-aware attribution for account scans ───────────────
  // For account scans, resolve the folder topology FIRST, build the
  // file→entity attributor from it, and pass it into batch processing so
  // every campaign observation routes to its correct campaign bucket.
  // Campaign scans skip this — they scan within a single known campaign
  // and don't need cross-campaign attribution.
  let attributor: Attributor | null = null;
  let nameDirectory: CampaignNameDirectory | null = null;
  /** FolderNode.path by folder id — the deterministic breadcrumb (NOT the
   *  LLM-echoed folder_path). Used to persist campaign.driveFolderPath at
   *  creation so the merge's year gate has a structural year to read. */
  let folderPathById: Map<string, string> | null = null;
  if (ctx.type === 'account') {
    log(rule('Resolve structure (Stage 2 — file→entity attribution)'));
    // existingCampaigns is read fresh every chunk — auto-created
    // candidates during bootstrap mean the DB list grows mid-chain;
    // nameDirectory rebuilds against the current list. Cheap query.
    const existingCampaigns = (
      await prisma.campaign.findMany({
        where: { accountId: ctx.id, driveFolderId: { not: null } },
        select: { id: true, name: true, driveFolderId: true },
      })
    )
      .filter((c): c is { id: string; name: string; driveFolderId: string } => !!c.driveFolderId)
      .map((c) => ({ id: c.id, name: c.name, driveFolderId: c.driveFolderId }));
    log(`  Existing campaigns in DB: ${existingCampaigns.length}`);

    // ── Structure cache check ─────────────────────────────────────────
    //
    // Chunks 2..N of a bootstrap chain reuse the structure computed by
    // chunk #1. We trust the cache for bootstrap (chain runs in hours;
    // structure barely changes). For forward sync, we'll re-gather +
    // re-hash + compare fingerprint before reusing. Today this code
    // only runs from bootstrap mode, so cache-hit = trust.
    let entityMap: EntityMap | null = null;
    const cached = ctx.driveStructureClassification as StructureCache | null;
    if (cached && cached.entityMap) {
      log(`  ✓ Structure cache HIT  (fingerprint=${cached.fingerprint.slice(0, 12)}…)`);
      log(`    Skipping ~33s folder gather + ~1m45s LLM classify.`);
      entityMap = cached.entityMap as EntityMap;
    } else {
      log('  Gathering folders…');
      const isTTY = process.stdout.isTTY === true;
      let lastTick = Date.now();
      const folders = await timed('structure_walk', () =>
        gatherFolders(ctx.folderId, ctx.name, {
          onProgress: (n) => {
            if (!isTTY) return;
            if (Date.now() - lastTick < 150) return;
            lastTick = Date.now();
            process.stdout.write('\r' + `    …${n} folders so far`.padEnd(40));
          },
        }),
      );
      if (isTTY) process.stdout.write('\r' + ' '.repeat(40) + '\r');
      log(`  Gathered ${folders.length} folders.`);
      log('  Classifying with LLM…');
      entityMap = await timed('structure_classify', () =>
        classifyFolders({
          accountId: ctx.id,
          accountName: ctx.name,
          rootFolderId: ctx.folderId,
          folders,
          existingCampaigns,
        }),
      );
      // Persist for chunks 2..N. Fingerprint over the folder list so
      // forward sync can detect drift later.
      if (!args.dryrun) {
        const fingerprint = structureFingerprint(
          folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
        );
        await persistStructureCache(ctx.accountId, {
          fingerprint,
          entityMap,
          folders,
        });
        log(`  ✓ Structure cache WRITTEN  (fingerprint=${fingerprint.slice(0, 12)}…)`);
      }
    }
    const classifiedCounts = {
      existing: entityMap.classified.filter((c) => c.classification === 'existing_campaign').length,
      fresh: entityMap.classified.filter((c) => c.classification === 'new_campaign').length,
      acct: entityMap.classified.filter((c) => c.classification === 'account_level').length,
    };
    log(
      `  Classified: ${classifiedCounts.existing} existing campaigns, ${classifiedCounts.fresh} new candidates, ${classifiedCounts.acct} account-level  [${entityMap.driver}]`,
    );
    log('');

    // ── Piece-anchor overlay — fresh from the DB every chunk, NEVER cached.
    // Folders that belong to a campaign via campaign_pieces (merged-variant
    // folders) are pinned to their owning campaign, overriding whatever the
    // LLM classified them as. This is what makes a merge STICK: without it
    // the next scan re-creates the merged folder as a new campaign.
    const pieceRows = await prisma.campaignPiece.findMany({
      where: { campaign: { accountId: ctx.id } },
      select: {
        id: true,
        name: true,
        driveFolderId: true,
        campaignId: true,
        campaign: { select: { name: true } },
      },
    });
    const pieceAnchors: PieceAnchor[] = pieceRows
      .filter((p): p is typeof p & { driveFolderId: string } => !!p.driveFolderId)
      .map((p) => ({
        driveFolderId: p.driveFolderId,
        campaignId: p.campaignId,
        campaignName: p.campaign.name,
        pieceId: p.id,
        pieceName: p.name,
      }));
    if (pieceAnchors.length > 0) {
      entityMap = overlayPieceAnchors(entityMap, pieceAnchors);
      log(`  Piece anchors: ${pieceAnchors.length} folder(s) pinned to their owning campaign`);
      log('');
    }

    folderPathById = new Map(entityMap.allFolders.map((f) => [f.id, f.path]));
    attributor = buildAttributor(entityMap, pieceAnchors);
    nameDirectory = buildCampaignNameDirectory(entityMap, existingCampaigns);
    log(
      `  Known-campaign vocabulary for per-file LLM: ${nameDirectory.knownCampaignNames.length} name${nameDirectory.knownCampaignNames.length === 1 ? '' : 's'}`,
    );
    log('');
  }

  // ── Files cache check ─────────────────────────────────────────────────
  //
  // Chunks 2..N of a bootstrap chain reuse the file list + active-date
  // buckets computed by chunk #1. Each chunk just advances the cursor
  // through the cached activeDates — no fresh files.list pagination
  // needed. Cache is NULLed on bootstrap completion (see persistCursor).
  log(rule('Discover files'));
  let allFiles: TraversedFile[];
  let activeDates: DayBucket[];
  const cachedFiles = ctx.driveBootstrapFiles as BootstrapFilesCache | null;
  if (cachedFiles && cachedFiles.files && cachedFiles.activeDates) {
    log(`  ✓ Files cache HIT  (${cachedFiles.files.length} files, ${cachedFiles.activeDates.length} active days)`);
    log(`    Skipping ~3 min file discovery + grouping.`);
    allFiles = cachedFiles.files;
    activeDates = cachedFiles.activeDates;
  } else {
    allFiles = await timed('file_discovery', () =>
      gatherFilesAuto(ctx.folderId, ctx.name, args.newestFirst),
    );
    // Campaign scans also gather each piece's folder, tagging files with
    // their piece. Piece-tagged copies WIN on id collision (a piece folder
    // nested inside the campaign root would otherwise double-count).
    if (piecesById.size > 0) {
      const byId = new Map(allFiles.map((f) => [f.id, f]));
      for (const [pieceId, info] of piecesById) {
        const pieceFiles = await timed('file_discovery', () =>
          gatherFilesRecursive(info.driveFolderId, `${ctx.name} · ${info.name}`, args.newestFirst),
        );
        for (const f of pieceFiles) byId.set(f.id, { ...f, pieceId });
      }
      allFiles = Array.from(byId.values());
      log(`  + piece folders gathered (${piecesById.size}) → total ${allFiles.length} files`);
    }
    log(`  Total files in folder: ${allFiles.length}`);
    if (allFiles.length === 0) {
      log('  Nothing to do. Exiting.');
      return emptyResult();
    }

    activeDates = groupFilesByDate(allFiles);
    if (args.newestFirst) activeDates.reverse();
    if (activeDates.length === 0) {
      log('  No files have modifiedTime — nothing to scan. Exiting.');
      return emptyResult();
    }
    // Persist for chunks 2..N.
    if (!args.dryrun) {
      await persistBootstrapFilesCache(ctx.accountId, { files: allFiles, activeDates });
      log(`  ✓ Files cache WRITTEN  (${allFiles.length} files)`);
    }
  }
  log(`  Active days: ${activeDates.length}  (${activeDates[0]!.date} → ${activeDates[activeDates.length - 1]!.date})`);
  log('');

  if (args.dryrun) {
    log('  --dryrun is set: nothing will be written to the DB.');
  } else {
    log('  ⚠ Persisting to DB (system-staff attribution). Use --dryrun to preview.');
  }
  log('');

  // ── One-day scan ─────────────────────────────────────────────────────────
  //
  // Locked invariant: **one scan = one active day of file CRUD**. Each
  // invocation picks the first activeDate strictly greater than the
  // account's cursor, processes its files, persists the cursor, and
  // returns. Walking N days = N invocations — the queue chains
  // continuations one row at a time via backfill-queue.ts; CLI users
  // loop manually. The old --scans / --all / wall-clock-budget knobs
  // were removed; the engine no longer loops across active days.
  //
  // Why one-day-per-scan:
  //   - cursor advancement is unambiguous (scansProcessed ∈ {0,1})
  //   - persist failure can throw without losing other days' work
  //     (there are no other days in this run)
  //   - the structure walk's cost is amortized across the chain at
  //     the queue level, not the engine level
  //   - re-scan overlap on continuation chunks becomes impossible by
  //     construction

  let scansDone = 0;
  let filesProcessed = 0;
  const effectiveCursor: string | null = ctx.driveBootstrapCursor;
  const initialCursor = effectiveCursor;
  log(`  Cursor (accounts.drive_bootstrap_cursor): ${effectiveCursor ?? 'none — starting from earliest active day'}`);
  log('');

  let finalCursor: string | null = effectiveCursor;
  let bootstrapCompleted = false;
  const nextDay = activeDates.find((d) => !effectiveCursor || d.date > effectiveCursor);
  if (!nextDay) {
    log(rule(`No active days past ${effectiveCursor ?? '(start)'} — bootstrap caught up`));
    bootstrapCompleted = true;
    // Persist the completion flag even when no day was processed —
    // signals to the queue and UI that bootstrap is done. Cursor stays
    // at the last processed day (or null if the drive was empty).
    if (!args.dryrun && effectiveCursor) {
      await timed('persist_cursor', () =>
        persistCursor(ctx.accountId, effectiveCursor, true),
      );
    }
  } else {
    log(rule(`Scan: ${nextDay.date}  (${nextDay.files.length} file${nextDay.files.length === 1 ? '' : 's'})`));
    filesProcessed = nextDay.files.length;

    // ── Pre-filter: skip-able files don't need revision metadata ─────────
    //
    // The revisions fetch below is one Drive API call per file. Under the
    // 4/s rate limiter that adds up — a day with 350 files (most of them
    // PNG/JPEG that extractText would skip on mime alone) was eating ~80s
    // here for no downstream benefit. predictExtractionSkip is the same
    // metadata-only check extractText runs first; if it returns a skip,
    // we know the file is going to be ⊘'d in processBatch anyway. Log it
    // the same way processBatch would, then short-circuit.
    const extractable: TraversedFile[] = [];
    let preFilterSkipped = 0;
    for (const file of nextDay.files) {
      const predicted = predictExtractionSkip(file);
      if (predicted) {
        const detail = predicted.detail ? ` (${predicted.detail})` : '';
        log(`    ⊘ ${file.name}  [${file.mimeType}]  skip: ${predicted.reason}${detail}  (pre-filtered, no revisions fetch)`);
        preFilterSkipped++;
      } else {
        extractable.push(file);
      }
    }
    if (preFilterSkipped > 0) {
      log(
        `  Pre-filter: ${extractable.length} extractable / ${preFilterSkipped} skipped on mime/size; saving ${preFilterSkipped} revisions.list calls`,
      );
    }

    // Fetch revisions only for files that will actually be extracted.
    log('  Fetching revision metadata…');
    const withRevisions: FileWithRevisions[] = [];
    let revFailures = 0;
    const isTTY = process.stdout.isTTY === true;
    let lastTick = Date.now();
    for (let i = 0; i < extractable.length; i++) {
      const file = extractable[i]!;
      if (isTTY && Date.now() - lastTick > 250) {
        lastTick = Date.now();
        const nameTail = file.name.length > 40 ? '…' + file.name.slice(-40) : file.name;
        process.stdout.write('\r' + `    ${i + 1}/${extractable.length}  ${nameTail}`.padEnd(100).slice(0, 100));
      }
      try {
        const revs = await timed('revisions_fetch', () => listRevisions(file.id));
        withRevisions.push({ file, revisions: revs });
      } catch {
        revFailures++;
        withRevisions.push({ file, revisions: [] });
      }
    }
    if (isTTY) process.stdout.write('\r' + ' '.repeat(100) + '\r');
    if (revFailures > 0) log(`  ⚠ ${revFailures} file(s) failed revisions.list`);
    log('');

    const scanStart = Date.now();
    const outcome = await processBatch(
      withRevisions,
      ctx,
      attributor,
      nameDirectory,
      folderPathById,
      piecesById.size > 0 ? piecesById : null,
      !args.dryrun,
      nextDay.date,
    );
    const scanMs = Date.now() - scanStart;

    // ── Print synthesized status_markdowns for this scan ──────────────
    log('');
    log(`  ── Synthesized (${outcome.synthesized.length} entit${outcome.synthesized.length === 1 ? 'y' : 'ies'}) ──`);
    if (outcome.synthesized.length === 0) {
      log('     (no entities synthesized this scan)');
    }
    for (const result of outcome.synthesized) {
      log('');
      const header =
        result.entityStatus === 'account'
          ? `Account: "${result.entityName}"`
          : result.entityStatus === 'piece'
            ? `Piece: "${result.entityName}"`
            : result.entityStatus === 'existing'
              ? `Campaign (existing): "${result.entityName}"`
              : `Campaign (NEW candidate): "${result.entityName}"`;
      log(`  ▸ ${header}`);
      log(
        `     ${result.observationsCount} obs / ${result.filesCount} file(s)  ·  synthesis ${fmtMs(result.synthesisMs)}`,
      );
      if (result.distillResult) {
        log(
          `     distill: ${result.distillResult.proposalsCreated} field changes / ${result.distillResult.notesWritten} notes`,
        );
      }
      log('     ┌── status_markdown ──────────────────');
      for (const line of result.synthesizedMarkdown.split('\n')) {
        log(`     │ ${line}`);
      }
      log('     └─────────────────────────────────────');
      if (result.synthesizedSensitiveMarkdown) {
        log('     ┌── status_sensitive_markdown ────── ⚠ restricted');
        for (const line of result.synthesizedSensitiveMarkdown.split('\n')) {
          log(`     │ ${line}`);
        }
        log('     └─────────────────────────────────────');
      }
    }

    log('');
    log(`  ✓ Scan done in ${fmtMs(scanMs)}  (${nextDay.date})`);
    log('');

    scansDone = 1;
    finalCursor = nextDay.date;

    // Was this the last active day? If so, bootstrap is complete after
    // this chunk — mark it. The find returns the FIRST date strictly
    // greater than nextDay.date; if there isn't one, we're done.
    const followUpDay = activeDates.find((d) => d.date > nextDay.date);
    bootstrapCompleted = !followUpDay;

    // Persist the cursor. NO try/catch — failure must propagate. With
    // only one day per chunk, swallowing here would leave the row
    // reporting `completed` while the DB cursor stays stale. Synthesis
    // writes are already committed above (processBatch with
    // persist=true), so letting this throw doesn't lose observation
    // data — only the cursor stamp, which the next chunk will redo
    // from the same starting point.
    if (!args.dryrun) {
      await timed('persist_cursor', () =>
        persistCursor(ctx.accountId, nextDay.date, bootstrapCompleted),
      );
    }
  }

  const overallMs = Date.now() - overallStart;
  log(
    rule(
      `Backfill done — ${scansDone} scan / ${filesProcessed} file${filesProcessed === 1 ? '' : 's'} processed in ${fmtMs(overallMs)}`,
    ),
  );

  // Phase summary goes LAST so it survives the 40-line tailLogSummary
  // and appears in the gub-admin Recent backfill requests row.
  printPhaseSummary(overallMs);
  log('');

  return {
    scansProcessed: scansDone,
    filesProcessed,
    durationMs: overallMs,
    finalCursorYmd: finalCursor !== initialCursor ? finalCursor : null,
    activeDaysFirst: activeDates[0]!.date,
    activeDaysLast: activeDates[activeDates.length - 1]!.date,
    activeDaysCount: activeDates.length,
    structureOnlyMode: false,
    bootstrapCompleted,
  };
}

// Guard: only run the CLI entry when this file IS the entry point.
// When imported as a module (e.g., backfill-queue.ts imports
// runBackfill), main() would otherwise execute on import, fail
// parseArgs against the wrong argv, and crash the importer.
if (require.main === module) {
  main()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      if (err instanceof Error && err.stack) console.error(err.stack);
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
