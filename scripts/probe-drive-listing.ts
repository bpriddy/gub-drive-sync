/**
 * probe-drive-listing.ts — measure the flat Drive listing on real roots.
 *
 * Read-only. For one account it runs the production listing code
 * (probeFolder, listAllFoldersInDrive, listSubtreeFiles) at 1000 items per
 * page and prints what it cost: page counts, per-page latency and the
 * parent-map counters. Its own output carries no file or folder names or ids
 * (errors are reduced to a status or an error code); a transient-retry
 * warning from the Drive transport may still quote a request.
 *
 * It measures both production paths: the folder sweep a forward run repeats,
 * then the file discovery, which lists the folders again before the files.
 * Calls: 1 files.get + 2 × ceil(drive folders / 1000) + ceil(drive files /
 * 1000) files.list; for 7k folders and 27k files, 1 + 14 + 27 = 42. $0, but
 * it reads a live Drive through the bot, so it needs an explicit go each
 * time it runs.
 *
 * --probe-only stops after the files.get and prints the root kind
 * (drive_root | in_drive | my_drive). With --all it does that for every
 * account with a Drive folder, one call each: the root-shape census.
 *
 * Usage:
 *   npm run probe-drive-listing -- --account-id <uuid>
 *   npm run probe-drive-listing -- --account-id <uuid> --probe-only
 *   npm run probe-drive-listing -- --all --probe-only
 */

import { prisma } from '../src/prisma';
import {
  driveClient,
  FlatListingUnavailableError,
  httpStatusOf,
  listAllFoldersInDrive,
  listingFailureCause,
  probeFolder,
  type SharedDriveProbe,
} from '../src/drive/client';
import { buildTreeFromFlat, folderMapStats, type ParentMapStats } from '../src/drive/folder-tree';
import { listSubtreeFiles } from '../src/drive/subtree';

interface Args {
  accountId?: string;
  all: boolean;
  probeOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const i = argv.indexOf('--account-id');
  const accountId = i >= 0 ? argv[i + 1] : undefined;
  return {
    ...(accountId ? { accountId } : {}),
    all: argv.includes('--all'),
    probeOnly: argv.includes('--probe-only'),
  };
}

type RootKind = 'drive_root' | 'in_drive' | 'my_drive';

const kindOf = (p: SharedDriveProbe): RootKind =>
  p.isSharedDriveRoot ? 'drive_root' : p.driveId ? 'in_drive' : 'my_drive';

/** One timed files.list request: which sweep, items returned, wall time. */
interface Page {
  kind: 'folders' | 'files';
  items: number;
  ms: number;
  failed: boolean;
}

/**
 * Time every files.list request the production code makes, by wrapping the
 * cached client's method. The wrapper sits inside the rate limiter, so the
 * 250 ms pacing between calls is not counted as page latency, and the probe
 * before it has already paid the OAuth token refresh. Each request is
 * classified by its query; a failed attempt (later retried) is kept, flagged.
 */
async function recordPages(): Promise<Page[]> {
  const client = await driveClient();
  const pages: Page[] = [];
  const list = client.files.list.bind(client.files) as (
    ...args: unknown[]
  ) => Promise<{ data: { files?: unknown[] } }>;
  (client.files as unknown as { list: typeof list }).list = async (...args) => {
    const q = String((args[0] as { q?: unknown } | undefined)?.q ?? '');
    const kind = /mimeType\s*!=/.test(q) ? 'files' : 'folders';
    const started = performance.now();
    try {
      const res = await list(...args);
      pages.push({
        kind,
        items: res.data.files?.length ?? 0,
        ms: performance.now() - started,
        failed: false,
      });
      return res;
    } catch (err) {
      pages.push({ kind, items: 0, ms: performance.now() - started, failed: true });
      throw err;
    }
  };
  return pages;
}

/** An error, reduced to what is safe to print: a status, reasons or a code. */
function safeCause(err: unknown): string {
  if (httpStatusOf(err) !== undefined) return listingFailureCause(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  if (err instanceof FlatListingUnavailableError) return listingFailureCause(err);
  return err instanceof Error ? err.name : 'unknown error';
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function pageLine(label: string, all: Page[]): string {
  const pages = all.filter((p) => !p.failed);
  const failed = all.length - pages.length;
  const ms = pages.map((p) => p.ms).sort((a, b) => a - b);
  const items = pages.reduce((n, p) => n + p.items, 0);
  const f = (n: number): string => `${Math.round(n)} ms`;
  return (
    `  ${label}: ${pages.length} page(s), ${items} item(s); latency p50 ${f(quantile(ms, 0.5))}` +
    ` / p95 ${f(quantile(ms, 0.95))} / max ${f(ms[ms.length - 1] ?? 0)}` +
    (failed > 0 ? `; ${failed} failed attempt(s), retried` : '')
  );
}

const statsLine = (label: string, s: ParentMapStats): string =>
  `  parent map (${label}): in_scope=${s.in_scope} out_of_scope=${s.out_of_scope} orphans=${s.orphans} multi_parent=${s.multi_parent} depth_cap=${s.depth_cap}`;

async function census(): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: { driveFolderId: { not: null } },
    select: { id: true, driveFolderId: true },
    orderBy: { id: 'asc' },
  });
  console.log(`Root-shape census: ${accounts.length} account(s), 1 files.get each`);
  for (const a of accounts) {
    try {
      console.log(`  ${a.id}  ${kindOf(await probeFolder(a.driveFolderId!))}`);
    } catch (err) {
      console.log(`  ${a.id}  probe failed (${safeCause(err)})`);
    }
  }
}

async function measure(accountId: string, probeOnly: boolean): Promise<void> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { driveFolderId: true },
  });
  if (!account.driveFolderId) throw new UsageError(`account ${accountId} has no drive_folder_id`);
  const rootId = account.driveFolderId;

  const started = performance.now();
  const probe = await probeFolder(rootId);
  console.log(`Account ${accountId}: root ${kindOf(probe)}`);
  if (probeOnly) return;
  if (!probe.driveId) {
    console.log('  My Drive root: no flat listing exists; nothing to measure.');
    return;
  }

  const pages = await recordPages();
  try {
    // The folder sweep as gatherFolders runs it (forward, every busy run)…
    const flat = await listAllFoldersInDrive(probe.driveId);
    const folderPages = pages.splice(0);
    const tree = buildTreeFromFlat(rootId, 'root', flat);
    // …then the file discovery a root inside a drive runs at bootstrap, and
    // the catch-up runs for any drive root; it re-lists the folders first.
    // (A drive-root bootstrap still uses listSharedDriveFiles: same pages.)
    const { stats } = await listSubtreeFiles(rootId, 'root', probe.driveId);
    const discoveryPages = pages.splice(0);
    const filePages = discoveryPages.filter((p) => p.kind === 'files');

    console.log(pageLine('folders', folderPages));
    console.log(pageLine('files', filePages));
    console.log(statsLine('folders', folderMapStats(rootId, probe.driveId, flat, tree)));
    console.log(statsLine('files', stats));
    const calls = 1 + folderPages.length + discoveryPages.length;
    console.log(
      `  total: ${calls} call(s) in ${((performance.now() - started) / 1000).toFixed(1)} s` +
        ` (forward sweep ${1 + folderPages.length}, discovery ${1 + discoveryPages.length})`,
    );
  } catch (err) {
    console.log(`  flat listing refused or failed (${safeCause(err)})`);
    process.exitCode = 2;
  }
}

class UsageError extends Error {}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    if (!args.probeOnly)
      throw new UsageError('--all runs only with --probe-only (one call per account)');
    await census();
  } else if (args.accountId) {
    await measure(args.accountId, args.probeOnly);
  } else {
    throw new UsageError('pass --account-id <uuid>, or --all --probe-only');
  }
}

main()
  .catch((err) => {
    // A Drive or network error message can quote a file id or a request URL.
    // Usage errors are this script's own and safe to print in full.
    console.error(err instanceof UsageError ? err.message : `failed (${safeCause(err)})`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
