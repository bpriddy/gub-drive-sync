/**
 * drive/snapshot-refresh.ts — one-shot catch-up of the Drive name index.
 *
 * drive_file_snapshots is the index GUB searches by file name
 * (GET /org/files/search). Until the scan core started writing it
 * (src/scan/process-batch.ts, recordSnapshot), only the v1 scanFolder path
 * did — and the daily scheduler had moved from v1 `poll` to `forward-all`,
 * so the index stopped at the last v1 run. The scan core now keeps it
 * current, but only for files that change again: anything created, renamed
 * or moved in the gap stays unfindable until its next edit.
 *
 * This lists each account's Drive tree — listing only: no extraction, no
 * LLM — and writes one row per file that has no snapshot, or whose name,
 * path, mime type or modified time differs from its latest one. Unchanged
 * files get no row, so a re-run is a no-op.
 *
 * The listing is the flat one (drive/subtree.ts) for any root inside a
 * shared drive: about one files.list call per 1000 items of the drive, not
 * one per folder. A root the bot cannot list flat falls back to the walk, a
 * My Drive root always walks. The root label is the account's name, the one
 * the forward run roots its paths at, so a row written here has the path a
 * forward row of the same file would have.
 *
 * Rows carry was_extracted=false and skip_reason='index_refresh'. GUB's
 * `_sources` lists and resolveDriveFiles read extracted rows only, so they
 * are untouched; file search reads the latest row per file and gets the
 * current name. checkDelta ignores these rows — an index row says nothing
 * about which version was last extracted.
 *
 * v1 left a trap in the path comparison. Its full sync scanned each account
 * from the account root, then each campaign folder again rooted at the
 * campaign's NAME, so a file inside a campaign folder has two rows per run:
 * the account scan's (`<account> / …`) and, written after it, the campaign
 * scan's (`<campaign> / …`, campaign_id set). The campaign row is the latest
 * and no listing path starts like it, so every such file would count as moved.
 * For those rows the path is compared with the account-rooted row the SAME
 * run wrote for the file instead. A campaign folder that really moved since
 * still shows up: the listing's path differs from the run's account row too.
 *
 * Output is counts only — no file names, paths or ids — and a failed write is
 * reported through reportSnapshotWriteFailure (one WARN, ids and codes only).
 *
 * Invoked via `main.ts refresh-snapshots [--account-id X] [--confirm]`.
 * Without --confirm it counts what it would write and writes nothing. A
 * listing that fails aborts the run; rows already written stay (append-only)
 * and a re-run skips them.
 */

import { prisma } from '../prisma';
import { log, rule } from '../scan/output';
import { isListingUnavailableError, listingFailureCause, probeFolder } from './client';
import { INDEX_REFRESH_SKIP_REASON, reportSnapshotWriteFailure, writeSnapshot } from './snapshot';
import { listSubtreeFiles } from './subtree';
import { traverseFolder } from './traversal';
import type { TraversedFile } from './types';

/** The latest snapshot row's fields the refresh compares against. */
export interface LatestSnapshot {
  fileId: string;
  name: string;
  path: string | null;
  mimeType: string | null;
  modifiedTime: Date | null;
  campaignId: string | null;
  syncRunId: string | null;
}

export type RefreshReason = 'unindexed' | 'renamed' | 'moved' | 'modified' | 'mime_changed';

/**
 * A row a v1 campaign scan wrote: its path is rooted at the campaign's name,
 * not the account's. Only v1 rows carry a sync_run_id (the scan core and this
 * catch-up leave it NULL) and only campaign scans a campaign_id.
 */
export function isLegacyCampaignRow(
  row: Pick<LatestSnapshot, 'syncRunId' | 'campaignId'>,
): boolean {
  return row.syncRunId !== null && row.campaignId !== null;
}

/**
 * Why this file needs a new index row, or null when its latest snapshot
 * already describes it. Name first: a rename is what file search misses.
 *
 * `accountRootedPath` stands in for `latest.path` in the move check: the
 * account-rooted path of the same v1 run, for a legacy campaign row.
 */
export function snapshotRefreshReason(
  file: TraversedFile,
  latest: LatestSnapshot | undefined,
  accountRootedPath?: string,
): RefreshReason | null {
  if (!latest) return 'unindexed';
  if (latest.name !== file.name) return 'renamed';
  if ((accountRootedPath ?? latest.path ?? null) !== file.path) return 'moved';
  const driveModified = file.modifiedTime ? new Date(file.modifiedTime).getTime() : null;
  if ((latest.modifiedTime?.getTime() ?? null) !== driveModified) return 'modified';
  if ((latest.mimeType ?? null) !== file.mimeType) return 'mime_changed';
  return null;
}

/**
 * The campaign a file lives under: the nearest ancestor folder that is a
 * campaign's or a piece's Drive folder. `parentOf` maps each folder of the
 * listing to its parent (null once the parent is the root); a chain that
 * leaves the map ends the search.
 */
export function nearestCampaignId(
  file: TraversedFile,
  parentOf: Map<string, string | null>,
  campaignByFolderId: Map<string, string>,
): string | null {
  const seen = new Set<string>();
  let folderId: string | null = file.parents?.[0] ?? null;
  while (folderId && !seen.has(folderId)) {
    const campaignId = campaignByFolderId.get(folderId);
    if (campaignId) return campaignId;
    seen.add(folderId);
    folderId = parentOf.get(folderId) ?? null;
  }
  return null;
}

export interface RefreshCounts {
  /** Distinct files the listing returned. */
  filesSeen: number;
  /** Rows a --confirm run writes when nothing fails. */
  rowsPlanned: number;
  rowsWritten: number;
  byReason: Record<RefreshReason, number>;
  /**
   * Files whose latest row is a v1 campaign scan's, compared by the
   * account-rooted path of that same run.
   */
  legacyNormalized: number;
  /**
   * Such files whose run left no account-rooted row: compared as they are, so
   * a `moved` among them may be a false one.
   */
  legacyUnresolved: number;
  writeFailures: number;
  /** "<code> <constraint>" of each failed write, counted. */
  writeFailureReasons: Record<string, number>;
}

export interface SnapshotRefreshResult extends RefreshCounts {
  accounts: number;
  confirm: boolean;
}

function emptyCounts(): RefreshCounts {
  return {
    filesSeen: 0,
    rowsPlanned: 0,
    rowsWritten: 0,
    byReason: { unindexed: 0, renamed: 0, moved: 0, modified: 0, mime_changed: 0 },
    legacyNormalized: 0,
    legacyUnresolved: 0,
    writeFailures: 0,
    writeFailureReasons: {},
  };
}

function addCounts(into: RefreshCounts, from: RefreshCounts): void {
  into.filesSeen += from.filesSeen;
  into.rowsPlanned += from.rowsPlanned;
  into.rowsWritten += from.rowsWritten;
  for (const reason of Object.keys(from.byReason) as RefreshReason[]) {
    into.byReason[reason] += from.byReason[reason];
  }
  into.legacyNormalized += from.legacyNormalized;
  into.legacyUnresolved += from.legacyUnresolved;
  into.writeFailures += from.writeFailures;
  for (const [why, n] of Object.entries(from.writeFailureReasons)) {
    into.writeFailureReasons[why] = (into.writeFailureReasons[why] ?? 0) + n;
  }
}

/** The counts as one log fragment: numbers and error codes, never a name, path or id. */
function describeCounts(c: RefreshCounts, confirm: boolean): string {
  const r = c.byReason;
  const rows = confirm
    ? `${c.rowsWritten} of ${c.rowsPlanned} row(s) written`
    : `${c.rowsPlanned} row(s) would be written`;
  const failures = Object.entries(c.writeFailureReasons)
    .map(([why, n]) => `${why} x${n}`)
    .join(', ');
  return (
    `${rows} (unindexed ${r.unindexed}, renamed ${r.renamed}, moved ${r.moved}, ` +
    `modified ${r.modified}, mime_changed ${r.mime_changed}); ` +
    `legacy campaign rows: ${c.legacyNormalized} normalized, ${c.legacyUnresolved} unresolved` +
    (c.writeFailures > 0 ? `; ${c.writeFailures} write failure(s) [${failures}]` : '')
  );
}

// ── Latest rows ──────────────────────────────────────────────────────────────

const LOOKUP_CHUNK = 1000;

async function loadLatestSnapshots(fileIds: string[]): Promise<Map<string, LatestSnapshot>> {
  const out = new Map<string, LatestSnapshot>();
  for (let i = 0; i < fileIds.length; i += LOOKUP_CHUNK) {
    const chunk = fileIds.slice(i, i + LOOKUP_CHUNK);
    const rows = await prisma.$queryRaw<LatestSnapshot[]>`
      SELECT DISTINCT ON (file_id)
             file_id AS "fileId", name, path, mime_type AS "mimeType",
             modified_time AS "modifiedTime", campaign_id AS "campaignId",
             sync_run_id AS "syncRunId"
        FROM drive_file_snapshots
       WHERE file_id = ANY(${chunk}::text[])
       ORDER BY file_id, scanned_at DESC
    `;
    for (const r of rows) out.set(r.fileId, r);
  }
  return out;
}

const runFileKey = (syncRunId: string, fileId: string): string => `${syncRunId}/${fileId}`;

/**
 * For each legacy campaign row, the path of the account-scoped row the same
 * v1 run wrote for the file (campaign_id NULL, the newest if the run wrote
 * several). Keyed by runFileKey; a file whose run left no such row is absent.
 */
async function loadAccountRootedPaths(rows: LatestSnapshot[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < rows.length; i += LOOKUP_CHUNK) {
    const chunk = rows.slice(i, i + LOOKUP_CHUNK);
    const fileIds = chunk.map((r) => r.fileId);
    const runIds = chunk.map((r) => r.syncRunId!);
    const found = await prisma.$queryRaw<
      Array<{ fileId: string; syncRunId: string; path: string | null }>
    >`
      SELECT DISTINCT ON (s.file_id, s.sync_run_id)
             s.file_id AS "fileId", s.sync_run_id AS "syncRunId", s.path
        FROM drive_file_snapshots s
        JOIN unnest(${fileIds}::text[], ${runIds}::uuid[]) AS want(file_id, sync_run_id)
          ON s.file_id = want.file_id AND s.sync_run_id = want.sync_run_id
       WHERE s.campaign_id IS NULL
       ORDER BY s.file_id, s.sync_run_id, s.scanned_at DESC
    `;
    for (const r of found) if (r.path !== null) out.set(runFileKey(r.syncRunId, r.fileId), r.path);
  }
  return out;
}

// ── Listing ──────────────────────────────────────────────────────────────────

interface AccountListing {
  kind: 'flat' | 'walk';
  /** Distinct files, in listing order. */
  files: TraversedFile[];
  /** Folder id → parent folder id (null once the parent is the root). */
  parentOf: Map<string, string | null>;
  /** Subfolders the walk could not read (their files are not listed). */
  unreadableFolders: number;
  /** Subfolders past the depth cap (their files are not listed). */
  depthCapped: number;
}

async function walkTree(rootId: string, rootLabel: string): Promise<AccountListing> {
  const files: TraversedFile[] = [];
  const parentOf = new Map<string, string | null>();
  let unreadableFolders = 0;
  let depthCapped = 0;
  // The walk yields a folder before its children, so every ancestor of a
  // file is in parentOf by the time the file is.
  for await (const f of traverseFolder(rootId, rootLabel, {
    onFolderError: () => {
      unreadableFolders++;
    },
    onDepthCap: () => {
      depthCapped++;
    },
  })) {
    if (f.isFolder) parentOf.set(f.id, f.parents?.[0] ?? null);
    else files.push(f);
  }
  return { kind: 'walk', files, parentOf, unreadableFolders, depthCapped };
}

async function listAccountTree(
  accountId: string,
  rootId: string,
  rootLabel: string,
): Promise<AccountListing> {
  const probe = await probeFolder(rootId);
  if (probe.driveId) {
    try {
      const { files, folders, depthCapHits } = await listSubtreeFiles(
        rootId,
        rootLabel,
        probe.driveId,
      );
      return {
        kind: 'flat',
        files,
        parentOf: new Map(folders.map((f) => [f.id, f.parentId])),
        unreadableFolders: 0,
        depthCapped: depthCapHits,
      };
    } catch (err) {
      // The drive root has no other path (as in gatherFolders): a refusal
      // there would refuse the walk too, so it surfaces as it is.
      if (probe.isSharedDriveRoot || !isListingUnavailableError(err)) throw err;
      log(
        `  account ${accountId}: flat listing unavailable (${listingFailureCause(err)}) — falling back to the recursive walk`,
      );
    }
  }
  return walkTree(rootId, rootLabel);
}

/**
 * The mode's arguments, `[--account-id X | --account-id=X] [--confirm]`.
 * Strict: a mistyped flag or a missing value must not widen the scope of a
 * mode that writes, and a flag where the id should be (`--account-id
 * --confirm`) is a missing value, not an id.
 */
export function parseRefreshSnapshotsArgs(args: readonly string[]): {
  accountId?: string;
  confirm: boolean;
} {
  const out: { accountId?: string; confirm: boolean } = { confirm: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--confirm') {
      out.confirm = true;
      continue;
    }
    let value: string | undefined;
    if (arg.startsWith('--account-id=')) value = arg.slice('--account-id='.length);
    else if (arg === '--account-id') value = args[++i];
    else throw new Error(`mode=refresh-snapshots: unknown argument ${arg}`);
    if (!value || value.startsWith('--')) {
      throw new Error('mode=refresh-snapshots: --account-id needs a value');
    }
    out.accountId = value;
  }
  return out;
}

// ── Refresh ──────────────────────────────────────────────────────────────────

export async function refreshFileSnapshots(args: {
  accountId?: string;
  confirm?: boolean;
}): Promise<SnapshotRefreshResult> {
  const confirm = args.confirm === true;
  const result: SnapshotRefreshResult = { ...emptyCounts(), accounts: 0, confirm };

  const accounts = await prisma.account.findMany({
    where: {
      driveFolderId: { not: null },
      ...(args.accountId ? { id: args.accountId } : {}),
    },
    select: { id: true, name: true, driveFolderId: true },
    orderBy: { id: 'asc' },
  });
  // A mistyped --account-id must not read as "nothing to catch up".
  if (args.accountId && accounts.length === 0) {
    throw new Error('no account with that id has a drive_folder_id');
  }

  log('');
  log(rule(`Refresh Drive file index${confirm ? '' : '  (dry-run — no --confirm)'}`));

  for (const account of accounts) {
    result.accounts++;
    const counts = emptyCounts();

    const [campaigns, pieces] = await Promise.all([
      prisma.campaign.findMany({
        where: { accountId: account.id, driveFolderId: { not: null } },
        select: { id: true, driveFolderId: true },
      }),
      prisma.campaignPiece.findMany({
        where: { campaign: { accountId: account.id }, driveFolderId: { not: null } },
        select: { campaignId: true, driveFolderId: true },
      }),
    ]);
    const campaignByFolderId = new Map<string, string>();
    for (const c of campaigns) campaignByFolderId.set(c.driveFolderId!, c.id);
    for (const p of pieces) campaignByFolderId.set(p.driveFolderId!, p.campaignId);

    // List first, compare after: the latest-row lookup is batched by file id,
    // and a whole account's tree (tens of thousands of files) fits in memory.
    const listing = await listAccountTree(account.id, account.driveFolderId!, account.name);
    // A file listed twice (a legacy multi-parent item in a walk) is indexed
    // once, under its first path: a second path would flip the row on every run.
    const seen = new Set<string>();
    const files: TraversedFile[] = [];
    for (const f of listing.files) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      files.push(f);
    }
    counts.filesSeen = files.length;

    const latestById = await loadLatestSnapshots(files.map((f) => f.id));
    const accountRooted = await loadAccountRootedPaths(
      [...latestById.values()].filter(isLegacyCampaignRow),
    );

    for (const file of files) {
      const latest = latestById.get(file.id);
      let accountRootedPath: string | undefined;
      if (latest && isLegacyCampaignRow(latest)) {
        accountRootedPath = accountRooted.get(runFileKey(latest.syncRunId!, latest.fileId));
        if (accountRootedPath === undefined) counts.legacyUnresolved++;
        else counts.legacyNormalized++;
      }
      const reason = snapshotRefreshReason(file, latest, accountRootedPath);
      if (!reason) continue;
      counts.rowsPlanned++;
      counts.byReason[reason]++;
      if (!confirm) continue;
      try {
        await writeSnapshot({
          syncRunId: null,
          scope: {
            accountId: account.id,
            campaignId: nearestCampaignId(file, listing.parentOf, campaignByFolderId),
          },
          file,
          wasExtracted: false,
          skipReason: INDEX_REFRESH_SKIP_REASON,
        });
        counts.rowsWritten++;
      } catch (err) {
        counts.writeFailures++;
        const why = reportSnapshotWriteFailure(
          { fileId: file.id, accountId: account.id, source: 'refresh' },
          err,
        );
        counts.writeFailureReasons[why] = (counts.writeFailureReasons[why] ?? 0) + 1;
      }
    }

    const partial = [
      listing.unreadableFolders > 0 ? `${listing.unreadableFolders} unreadable subfolder(s)` : '',
      listing.depthCapped > 0 ? `${listing.depthCapped} subfolder(s) past the depth cap` : '',
    ].filter(Boolean);
    log(
      `  account ${account.id}: ${files.length} file(s) listed (${listing.kind}); ${describeCounts(counts, confirm)}` +
        `${partial.length > 0 ? `; files in ${partial.join(' and ')} not listed` : ''}`,
    );
    addCounts(result, counts);
  }

  log('');
  log(
    rule(
      `Refresh done — ${result.accounts} account(s), ${result.filesSeen} file(s) listed; ` +
        describeCounts(result, confirm),
    ),
  );
  if (!confirm && result.rowsPlanned > 0) {
    log('  Dry-run: nothing was written. Re-run with --confirm to write these rows.');
  }
  if (result.writeFailures > 0) {
    throw new Error(
      `${result.writeFailures} snapshot write failure(s) — see the [drive.snapshot] WARN lines; ` +
        're-run with --confirm to retry them (rows already written are not repeated)',
    );
  }
  return result;
}
