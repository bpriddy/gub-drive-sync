// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
// ── Args ─────────────────────────────────────────────────────────────────────

export interface Args {
  accountId?: string;
  campaignId?: string;
  newestFirst: boolean;
  outputPath: string | null;
  /** Stage 1: resolve + print the structure entity map, then exit. */
  structureOnly: boolean;
  /**
   * --flat: process EVERY file in ONE scan stamped with today's date —
   * no day-by-day historical replay, no cursor gating. For dev snapshots
   * ("just scan everything as of now"). Marks bootstrap completed.
   */
  flat?: boolean;
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
  /**
   * --concurrency N: per-file worker count WITHIN one day's batch (extract
   * → interpret → idea extraction run in parallel; all routing, counters,
   * and the idea match/merge ratchet stay serial in file-index order).
   * PARALLELISM NEVER CROSSES DAYS — days are a serial read-modify-write
   * chain over entity state. 1 = fully serial (the debugging escape hatch).
   * Default: DEFAULT_CONCURRENCY.
   */
  concurrency?: number;
}

/** Within-day per-file worker count when --concurrency isn't passed. */
export const DEFAULT_CONCURRENCY = 4;

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

export function parseArgs(argv: string[]): Args {
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
    flat: has('--flat'),
  };
  if (accountId) out.accountId = accountId;
  if (campaignId) out.campaignId = campaignId;

  const concurrencyRaw = get('--concurrency');
  if (concurrencyRaw !== undefined) {
    const n = Number(concurrencyRaw);
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      throw new Error('--concurrency must be an integer between 1 and 16');
    }
    out.concurrency = n;
  }

  if (out.structureOnly && !accountId) {
    throw new Error('--structure requires --account-id (structure resolution is account-rooted)');
  }
  return out;
}
