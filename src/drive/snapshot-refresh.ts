/**
 * drive/snapshot-refresh.ts — one-shot catch-up of the Drive name index.
 *
 * drive_file_snapshots is the index GUB searches by file name
 * (GET /org/files/search). Until the scan core started writing it
 * (src/scan/process-batch.ts, recordSnapshot), only the v1 scanFolder path
 * did — and the daily scheduler had moved from v1 `poll` to `forward-all`,
 * so the index stopped at the last v1 run, 2026-08-13. The scan core now
 * keeps it current, but only for files that change again: anything
 * created, renamed or moved in the gap stays unfindable until its next edit.
 *
 * This walks each account's Drive tree — listing only: no extraction, no
 * LLM — and writes one row per file that has no snapshot, or whose name,
 * path, mime type or modified time differs from its latest one. Unchanged
 * files get no row, so a re-run is a no-op.
 *
 * Rows carry was_extracted=false and skip_reason='index_refresh'. GUB's
 * `_sources` lists and resolveDriveFiles read extracted rows only, so they
 * are untouched; file search reads the latest row per file and gets the
 * current name. checkDelta ignores these rows — an index row says nothing
 * about which version was last extracted.
 *
 * Invoked via `main.ts refresh-snapshots [--account-id X] [--confirm]`.
 * Without --confirm it counts what it would write and writes nothing.
 */

import { prisma } from '../prisma';
import { summarizeError } from '../progress';
import { log, rule } from '../scan/output';
import { INDEX_REFRESH_SKIP_REASON, writeSnapshot } from './snapshot';
import { traverseFolder } from './traversal';
import type { TraversedFile } from './types';

/** The latest snapshot row's fields the refresh compares against. */
export interface LatestSnapshot {
  fileId: string;
  name: string;
  path: string | null;
  mimeType: string | null;
  modifiedTime: Date | null;
}

export type RefreshReason = 'unindexed' | 'renamed' | 'moved' | 'modified' | 'mime_changed';

/**
 * Why this file needs a new index row, or null when its latest snapshot
 * already describes it. Name first: a rename is what file search misses.
 */
export function snapshotRefreshReason(
  file: TraversedFile,
  latest: LatestSnapshot | undefined,
): RefreshReason | null {
  if (!latest) return 'unindexed';
  if (latest.name !== file.name) return 'renamed';
  if ((latest.path ?? null) !== file.path) return 'moved';
  const driveModified = file.modifiedTime ? new Date(file.modifiedTime).getTime() : null;
  if ((latest.modifiedTime?.getTime() ?? null) !== driveModified) return 'modified';
  if ((latest.mimeType ?? null) !== file.mimeType) return 'mime_changed';
  return null;
}

/**
 * The campaign a file lives under: the nearest ancestor folder that is a
 * campaign's or a piece's Drive folder. `parentOf` maps each folder the
 * walk has seen to its parent; the walk yields a folder before its
 * children, so every ancestor of a file is known by the time the file is.
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

export interface SnapshotRefreshResult {
  accounts: number;
  filesSeen: number;
  rowsWritten: number;
  /** Rows a --confirm run would write; equals rowsWritten when confirmed. */
  rowsPlanned: number;
  byReason: Record<RefreshReason, number>;
  writeFailures: number;
  confirm: boolean;
}

const LATEST_LOOKUP_CHUNK = 1000;

async function loadLatestSnapshots(fileIds: string[]): Promise<Map<string, LatestSnapshot>> {
  const out = new Map<string, LatestSnapshot>();
  for (let i = 0; i < fileIds.length; i += LATEST_LOOKUP_CHUNK) {
    const chunk = fileIds.slice(i, i + LATEST_LOOKUP_CHUNK);
    const rows = await prisma.$queryRaw<LatestSnapshot[]>`
      SELECT DISTINCT ON (file_id)
             file_id AS "fileId", name, path, mime_type AS "mimeType",
             modified_time AS "modifiedTime"
        FROM drive_file_snapshots
       WHERE file_id = ANY(${chunk}::text[])
       ORDER BY file_id, scanned_at DESC
    `;
    for (const r of rows) out.set(r.fileId, r);
  }
  return out;
}

export async function refreshFileSnapshots(args: {
  accountId?: string;
  confirm?: boolean;
}): Promise<SnapshotRefreshResult> {
  const confirm = args.confirm === true;
  const result: SnapshotRefreshResult = {
    accounts: 0,
    filesSeen: 0,
    rowsWritten: 0,
    rowsPlanned: 0,
    byReason: { unindexed: 0, renamed: 0, moved: 0, modified: 0, mime_changed: 0 },
    writeFailures: 0,
    confirm,
  };

  const accounts = await prisma.account.findMany({
    where: {
      driveFolderId: { not: null },
      ...(args.accountId ? { id: args.accountId } : {}),
    },
    select: { id: true, name: true, driveFolderId: true },
  });

  for (const account of accounts) {
    result.accounts++;
    log('');
    log(
      rule(`Refresh file snapshots: ${account.name}${confirm ? '' : '  (dry-run — no --confirm)'}`),
    );

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

    // Walk first, compare after: the latest-snapshot lookup is batched by
    // file id, and a whole Chevy-sized tree (~26k files) fits in memory.
    const parentOf = new Map<string, string | null>();
    const files: TraversedFile[] = [];
    let folderErrors = 0;
    for await (const f of traverseFolder(account.driveFolderId!, account.name, {
      onFolderError: ({ folderPath, err }) => {
        folderErrors++;
        log(`  ⚠ subfolder unreadable, skipped: ${folderPath} — ${summarizeError(err)}`);
      },
    })) {
      if (f.isFolder) {
        parentOf.set(f.id, f.parents?.[0] ?? null);
        continue;
      }
      files.push(f);
    }
    result.filesSeen += files.length;

    const latestById = await loadLatestSnapshots(files.map((f) => f.id));
    let accountPlanned = 0;
    for (const file of files) {
      const reason = snapshotRefreshReason(file, latestById.get(file.id));
      if (!reason) continue;
      accountPlanned++;
      result.rowsPlanned++;
      result.byReason[reason]++;
      if (!confirm) continue;
      try {
        await writeSnapshot({
          syncRunId: null,
          scope: {
            accountId: account.id,
            campaignId: nearestCampaignId(file, parentOf, campaignByFolderId),
          },
          file,
          wasExtracted: false,
          skipReason: INDEX_REFRESH_SKIP_REASON,
        });
        result.rowsWritten++;
      } catch (err) {
        result.writeFailures++;
        log(`  ✗ snapshot write failed for ${file.path}: ${summarizeError(err)}`);
      }
    }

    log(
      `  ${files.length} file(s) listed, ${accountPlanned} ${confirm ? 'written' : 'would be written'}` +
        `${folderErrors > 0 ? `, ${folderErrors} unreadable subfolder(s)` : ''}`,
    );
  }

  log('');
  log(
    rule(
      `Refresh done — ${result.rowsPlanned} row(s) ${confirm ? 'written' : 'planned'} ` +
        `(unindexed ${result.byReason.unindexed}, renamed ${result.byReason.renamed}, ` +
        `moved ${result.byReason.moved}, modified ${result.byReason.modified}, ` +
        `mime ${result.byReason.mime_changed})` +
        `${result.writeFailures > 0 ? ` / ${result.writeFailures} failed` : ''}`,
    ),
  );
  return result;
}
