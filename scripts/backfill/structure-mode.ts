// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import { prisma } from '../../src/prisma';
import { classifyFolders, gatherFolders, type ClassifiedFolder } from '../../src/drive/structure';
import { log, rule, fmtMs } from './output';
import type { EntityCtx } from './entity';
import type { EntityMap, FolderNode } from '../../src/drive/structure';

// ── Stage 1: structure-only ──────────────────────────────────────────────────

export async function runStructureOnly(ctx: EntityCtx): Promise<void> {
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
