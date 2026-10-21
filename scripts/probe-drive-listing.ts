/**
 * probe-drive-listing.ts — measure the flat Drive listing on real roots.
 *
 * Read-only. For one account it runs the production listing code
 * (probeFolder, listAllFoldersInDrive, listSubtreeFiles) at 1000 items per
 * page and prints what it cost: the folder sweep's page count, the wall
 * time of each phase and the parent-map counters. Its own output carries no file or folder names or ids
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

/** An error, reduced to what is safe to print: a status, reasons or a code. */
function safeCause(err: unknown): string {
  if (httpStatusOf(err) !== undefined) return listingFailureCause(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  if (err instanceof FlatListingUnavailableError) return listingFailureCause(err);
  return err instanceof Error ? err.name : 'unknown error';
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

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

  try {
    // The folder sweep as gatherFolders runs it (forward, every busy run)…
    let folderPages = 0;
    const sweepStarted = performance.now();
    const flat = await listAllFoldersInDrive(probe.driveId, { onPage: () => folderPages++ });
    const sweepMs = performance.now() - sweepStarted;
    const tree = buildTreeFromFlat(rootId, 'root', flat);
    // …then the file discovery a root inside a drive runs at bootstrap, and
    // the catch-up runs for any drive root; it re-lists the folders first.
    // (A drive-root bootstrap still uses listSharedDriveFiles: same pages.)
    const discoveryStarted = performance.now();
    const { files, stats } = await listSubtreeFiles(rootId, 'root', probe.driveId);
    const discoveryMs = performance.now() - discoveryStarted;

    console.log(
      `  folder sweep: ${folderPages} page(s), ${flat.length} folder(s) in the drive, ${secs(sweepMs)}`,
    );
    console.log(
      `  file discovery: ${files.length} file(s) in the subtree, ${secs(discoveryMs)}` +
        ' (it lists the folders again first)',
    );
    console.log(statsLine('folders', folderMapStats(rootId, probe.driveId, flat, tree)));
    console.log(statsLine('files', stats));
    console.log(`  total: ${secs(performance.now() - started)}`);
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
