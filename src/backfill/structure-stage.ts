// Driver-shared Stage 2: account folder topology → file→entity attribution.
// Extracted from run.ts so BOTH drivers (day-walk backfill, Activity forward)
// resolve structure identically. Bootstrap trusts the cache blindly (a chain
// runs in hours; structure barely drifts). Forward re-gathers and compares
// fingerprints before reusing — the behavior the cache comment always
// promised ("for forward sync, we'll re-gather + re-hash + compare").

import { prisma } from '../prisma';
import {
  buildAttributor,
  classifyFolders,
  gatherFolders,
  overlayPieceAnchors,
  type Attributor,
  type EntityMap,
  type PieceAnchor,
} from '../drive/structure';
import { log, rule } from '../scan/output';
import { timed } from '../scan/timing';
import {
  buildCampaignNameDirectory,
  type CampaignNameDirectory,
  type EntityCtx,
} from '../scan/batch-types';
import {
  persistStructureCache,
  structureFingerprint,
  type StructureCache,
} from './days';

export interface StructureStageResult {
  attributor: Attributor;
  nameDirectory: CampaignNameDirectory;
  familyByCampaignId: Map<string, string[]>;
  folderPathById: Map<string, string>;
}

export async function resolveAccountStructure(
  ctx: EntityCtx,
  opts: {
    /**
     * true (bootstrap): a cache hit is trusted without gathering.
     * false (forward): always gather; reuse the cached classification
     * only when the folder-list fingerprint still matches.
     */
    trustCache: boolean;
    /** false in dryrun — never persist the cache from a preview. */
    persistCache: boolean;
  },
): Promise<StructureStageResult> {
  log(rule('Resolve structure (Stage 2 — file→entity attribution)'));
  // existingCampaigns is read fresh every run — auto-created candidates
  // mean the DB list grows between runs; nameDirectory rebuilds against
  // the current list. Cheap query.
  const existingCampaigns = (
    await prisma.campaign.findMany({
      where: { accountId: ctx.id, driveFolderId: { not: null } },
      select: { id: true, name: true, driveFolderId: true },
    })
  )
    .filter((c): c is { id: string; name: string; driveFolderId: string } => !!c.driveFolderId)
    .map((c) => ({ id: c.id, name: c.name, driveFolderId: c.driveFolderId }));
  log(`  Existing campaigns in DB: ${existingCampaigns.length}`);

  const cached = ctx.driveStructureClassification as StructureCache | null;
  let entityMap: EntityMap | null = null;

  if (opts.trustCache && cached?.entityMap) {
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

    const fingerprint = structureFingerprint(
      folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
    );
    if (cached?.entityMap && cached.fingerprint === fingerprint) {
      log(`  ✓ Structure cache VALID  (fingerprint=${fingerprint.slice(0, 12)}… unchanged)`);
      log(`    Skipping ~1m45s LLM classify.`);
      entityMap = cached.entityMap as EntityMap;
    } else {
      if (cached?.entityMap) {
        log(`  Structure drift detected (fingerprint changed) — re-classifying.`);
      }
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
      if (opts.persistCache) {
        await persistStructureCache(ctx.accountId, {
          fingerprint,
          entityMap,
          folders,
        });
        log(`  ✓ Structure cache WRITTEN  (fingerprint=${fingerprint.slice(0, 12)}…)`);
      }
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

  // ── Piece-anchor overlay — fresh from the DB every run, NEVER cached.
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

  const folderPathById = new Map(entityMap.allFolders.map((f) => [f.id, f.path]));
  const attributor = buildAttributor(entityMap, pieceAnchors);
  const familyByCampaignId = new Map(existingCampaigns.map((c) => [c.id, [c.name]]));
  for (const a of pieceAnchors) {
    const fam = familyByCampaignId.get(a.campaignId);
    if (fam) fam.push(a.pieceName);
    else familyByCampaignId.set(a.campaignId, [a.campaignName, a.pieceName]);
  }
  const nameDirectory = buildCampaignNameDirectory(entityMap, existingCampaigns);
  log(
    `  Known-campaign vocabulary for per-file LLM: ${nameDirectory.knownCampaignNames.length} name${nameDirectory.knownCampaignNames.length === 1 ? '' : 's'}`,
  );
  log('');

  return { attributor, nameDirectory, familyByCampaignId, folderPathById };
}
