// Driver-shared Stage 2: account folder topology → file→entity attribution.
// Extracted from run.ts so BOTH drivers (day-walk backfill, Activity forward)
// resolve structure identically. Bootstrap trusts the cache blindly (a chain
// runs in hours; structure barely drifts). Forward re-gathers and compares
// fingerprints before reusing — the behavior the cache comment always
// promised ("for forward sync, we'll re-gather + re-hash + compare").

import { config } from '../config';
import { logger } from '../logger';
import { prisma } from '../prisma';
import {
  buildAttributor,
  capFolderTree,
  classifyFolders,
  CLASSIFY_INPUT_TOKEN_LIMIT,
  depthCapFor,
  estimateClassifyTokens,
  gatherFolders,
  overlayPieceAnchors,
  type Attributor,
  type ClassifiedFolder,
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
import { persistStructureCache, structureFingerprint, type StructureCache } from './days';

// ── Weekly full pass (CLASSIFY_DEPTH_CAP_MODE=auto, #69) ─────────────────────
//
// The cap hides a new campaign root that appears below it, and so does the
// capped fingerprint. Once a week the classifier sees the whole tree.

const FULL_PASS_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// A weekly schedule whose run starts a little earlier than last week's
// still gets its pass; a daily one still waits the full week.
const FULL_PASS_SLACK_MS = 12 * 60 * 60 * 1000;
// The token estimate is approximate, so an uncapped prompt estimated above
// this share of the model's input limit stays capped.
const FULL_PASS_INPUT_SHARE = 0.9;

/**
 * True when the last full pass is a week old, missing, unreadable or in the
 * future (a skewed clock must not postpone the pass indefinitely).
 */
function fullPassDue(fullPassAt: unknown, now: Date): boolean {
  if (typeof fullPassAt !== 'string') return true;
  const age = now.getTime() - Date.parse(fullPassAt);
  return Number.isNaN(age) || age < 0 || age >= FULL_PASS_INTERVAL_MS - FULL_PASS_SLACK_MS;
}

/** The cached classification's entries; [] when there is none. */
function cachedClassified(cached: StructureCache | null): ClassifiedFolder[] {
  const classified = (cached?.entityMap as Partial<EntityMap> | undefined)?.classified;
  return Array.isArray(classified) ? classified : [];
}

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

    // CLASSIFY_DEPTH_CAP_MODE=auto: the classifier sees the tree down to one
    // level below the deepest campaign root it found last time or campaign
    // anchor, not the whole tree.
    const anchorFolderIds = existingCampaigns.map((c) => c.driveFolderId);
    const depthCap =
      config.CLASSIFY_DEPTH_CAP_MODE === 'auto'
        ? depthCapFor(
            folders,
            cachedClassified(cached),
            anchorFolderIds,
            config.CLASSIFY_DEFAULT_DEPTH_CAP,
          )
        : undefined;
    if (depthCap !== undefined) log(`  Classify depth cap: ${depthCap}`);

    // Fingerprint the tree the classifier sees: with a cap, a change below it
    // no longer triggers a reclassify.
    const fingerprintAt = (cap: number | undefined): string =>
      structureFingerprint(
        (cap === undefined ? folders : capFolderTree(folders, cap, anchorFolderIds).folders).map(
          (f) => ({ id: f.id, name: f.name, parentId: f.parentId }),
        ),
      );
    const fingerprint = fingerprintAt(depthCap);

    // The weekly full pass runs only where its time is recorded: a dry run
    // would repeat it on every preview.
    const now = new Date();
    let fullPass = false;
    if (depthCap !== undefined && opts.persistCache && fullPassDue(cached?.fullPassAt, now)) {
      const estimatedTokens = estimateClassifyTokens(folders.length);
      if (estimatedTokens <= CLASSIFY_INPUT_TOKEN_LIMIT * FULL_PASS_INPUT_SHARE) {
        fullPass = true;
        log(`  Weekly full pass due — classifying all ${folders.length} folders uncapped.`);
      } else {
        logger.warn(
          {
            accountId: ctx.accountId,
            folders: folders.length,
            estimatedTokens,
            inputTokenLimit: CLASSIFY_INPUT_TOKEN_LIMIT,
            depthCap,
          },
          '[drive.structure] full pass over the input limit; staying capped',
        );
        log(
          `  ⚠ Weekly full pass skipped: ~${estimatedTokens} tokens uncapped is over the input limit; staying capped at depth ${depthCap}.`,
        );
      }
    }

    const classify = (cap: number | undefined): Promise<EntityMap> =>
      timed('structure_classify', () =>
        classifyFolders({
          accountId: ctx.id,
          accountName: ctx.name,
          rootFolderId: ctx.folderId,
          folders,
          existingCampaigns,
          depthCap: cap,
        }),
      );

    // A failed full pass falls back to the capped path below and still
    // records its time, so a pass that cannot succeed (timeouts, an input
    // the estimate undercounted) is retried next week, not on every run.
    let classified: EntityMap | null = null;
    if (fullPass) {
      log('  Classifying with LLM…');
      try {
        classified = await classify(undefined);
      } catch (err) {
        logger.warn(
          {
            accountId: ctx.accountId,
            folders: folders.length,
            depthCap,
            error: err instanceof Error ? err.message : String(err),
          },
          '[drive.structure] full pass failed; staying capped',
        );
        log(`  ⚠ Weekly full pass failed; staying capped at depth ${depthCap}.`);
      }
    }
    // A capped reclassify keeps the last full pass's time.
    const fullPassAt = fullPass
      ? now.toISOString()
      : typeof cached?.fullPassAt === 'string'
        ? cached.fullPassAt
        : undefined;

    if (!classified && cached?.entityMap && cached.fingerprint === fingerprint) {
      log(`  ✓ Structure cache VALID  (fingerprint=${fingerprint.slice(0, 12)}… unchanged)`);
      log(`    Skipping ~1m45s LLM classify.`);
      const reused = cached.entityMap as EntityMap;
      // A capped fingerprint misses folders created or moved below the cap:
      // attribute through this run's folder list, not the cached one.
      entityMap =
        depthCap === undefined
          ? reused
          : { ...reused, allFolders: folders, folderCount: folders.length };
      if (fullPass && fullPassAt) {
        await persistStructureCache(ctx.accountId, { ...cached, fullPassAt });
      }
    } else {
      if (!classified) {
        if (cached?.entityMap && cached.fingerprint !== fingerprint) {
          log(`  Structure drift detected (fingerprint changed) — re-classifying.`);
        }
        log('  Classifying with LLM…');
        classified = await classify(depthCap);
      }
      entityMap = classified;
      if (opts.persistCache) {
        // Store what the next run computes on an unchanged tree: its cap
        // comes from this classification, not the previous one.
        const nextFingerprint =
          depthCap === undefined
            ? fingerprint
            : fingerprintAt(
                depthCapFor(
                  folders,
                  entityMap.classified,
                  anchorFolderIds,
                  config.CLASSIFY_DEFAULT_DEPTH_CAP,
                ),
              );
        await persistStructureCache(ctx.accountId, {
          fingerprint: nextFingerprint,
          entityMap,
          folders,
          ...(depthCap !== undefined && fullPassAt ? { fullPassAt } : {}),
        });
        log(`  ✓ Structure cache WRITTEN  (fingerprint=${nextFingerprint.slice(0, 12)}…)`);
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
