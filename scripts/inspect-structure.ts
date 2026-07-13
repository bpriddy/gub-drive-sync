/**
 * inspect-structure.ts — local, read-only topology probe (runs under tsx, like
 * the probe-* scripts). Reads the account's campaigns from the DB and walks the
 * folder tree from Drive, annotating campaign roots — to ground the pieces work
 * (nested vs sibling deliverables). No LLM, no writes.
 *
 * Requires DB + Drive access. Locally: run cloud_sql_proxy to the dev instance
 * and override DATABASE_URL to it (the bot refresh token lives in that DB):
 *
 *   DATABASE_URL=postgresql://…@127.0.0.1:5433/gub_dev \
 *     npx tsx -r dotenv/config scripts/inspect-structure.ts \
 *       --account-name Chevy [--campaign-name BHAC] [--folder-id <id>]
 */

import { inspectStructure } from '../src/drive/inspect';
import { prisma } from '../src/prisma';

function argVal(flag: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const accountName = argVal('--account-name');
  const accountId = argVal('--account-id');
  const campaignName = argVal('--campaign-name');
  const folderId = argVal('--folder-id');
  const res = await inspectStructure({
    ...(accountName !== undefined ? { accountName } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(campaignName !== undefined ? { campaignName } : {}),
    ...(folderId !== undefined ? { folderId } : {}),
  });

  console.log(`\n=== ACCOUNT: ${res.accountName} ===`);
  console.log(`root folder: ${res.accountRootFolderId}`);
  console.log(`campaigns in DB: ${res.campaignCount}   folders walked: ${res.folderCount}`);

  console.log(`\n--- CAMPAIGN ROWS (${res.campaignCount}) ---`);
  for (const c of res.campaigns) {
    const inTree = c.driveFolderId ? (c.foundInTree ? '' : '  (folder NOT in walked tree)') : '  (no folder id)';
    console.log(`  • ${c.name}   [${c.driveFolderId ?? '—'}]${inTree}`);
  }

  console.log(`\n--- FOLDER TREE (root: ${res.gatherRootLabel}) ---`);
  console.log(res.renderedTree);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[inspect-structure] failed:', err instanceof Error ? err.message : err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
