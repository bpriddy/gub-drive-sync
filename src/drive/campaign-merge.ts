/**
 * campaign-merge.ts — one-shot detect-and-merge of duplicate Campaign rows
 * for an account. Runs inside the Cloud Run Job (mode: merge-campaign-dupes)
 * against the deployed DB, or locally via `npm run merge-campaign-dupes`.
 *
 * Flow (single execution):
 *   1. Resolve the account (by id or name fragment).
 *   2. Load all its Campaign rows.
 *   3. detectCampaignClusters — ONE Gemini call. The detector is
 *      split-by-default and only returns clusters at confidence >= 0.8.
 *   4. Filter to clusters at >= minConfidence (default 0.8; raise to be
 *      more conservative).
 *   5. For each cluster:
 *        - apply=false (no --confirm): log what WOULD merge. No LLM synth,
 *          no DB writes.
 *        - apply=true (--confirm): re-synthesize the canonical's markdown
 *          (reuses the production synthesis prompt) and run the per-cluster
 *          FK-redirect + delete transaction. Each cluster is its own
 *          transaction; one bad cluster doesn't abort the rest.
 *
 * Destructive. No rollback table (per the cleanup decision). The audit_log
 * records each merge; recovery is fix-forward or re-bootstrap.
 *
 * FK redirect order (campaign_changes FIRST — it's NOT NULL and blocks the
 * delete; see the Phase-0 schema audit):
 *   campaign_changes → drive_file_snapshots → drive_scan_logs →
 *   drive_change_proposals → access_grants(resource_type='campaign')
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { buildCampaignCurrentState } from './schema';
import {
  detectCampaignClustersWindowed,
  type DetectedCluster,
} from './campaign-cluster-detector';
import { mergeCampaignMarkdowns, type VariantMarkdown } from './campaign-merge-synthesizer';

/**
 * System staff attributed as the actor on merge audit-log entries. Same
 * sentinel used by backfill.ts for unattended writes.
 */
const DRIVE_SYNC_SYSTEM_STAFF_ID = 'dcd5d8e3-0000-4000-a000-000000000001';

/** Detector floor; clusters never come back below this. Operators may raise. */
const DEFAULT_MIN_CONFIDENCE = 0.8;

/** Higher = kept when collapsing a user's duplicate grants. */
const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  contributor: 2,
  manager: 3,
  admin: 4,
};

/**
 * Redirect campaign access_grants from the variants to the canonical,
 * collapsing collisions. A user may hold a grant on both a variant and the
 * canonical (or on two variants); a blind `resource_id` update would then
 * violate the unique (user_id, resource_type, resource_id). So per user we
 * keep ONE surviving grant — active beats revoked, then higher role, then a
 * grant already on the canonical — point it at the canonical, and delete the
 * rest. Handles all grants (incl. revoked) so it's correct whether the unique
 * index is partial or full.
 */
async function redirectAccessGrants(
  tx: Prisma.TransactionClient,
  canonicalId: string,
  variantIds: string[],
): Promise<void> {
  const allIds = [canonicalId, ...variantIds];
  const grants = await tx.accessGrant.findMany({
    where: { resourceType: 'campaign', resourceId: { in: allIds } },
    select: { id: true, userId: true, resourceId: true, role: true, revokedAt: true },
  });
  if (grants.length === 0) return;

  const score = (g: (typeof grants)[number]): number =>
    (g.revokedAt ? 0 : 100) + (ROLE_RANK[g.role] ?? 0);

  const byUser = new Map<string, typeof grants>();
  for (const g of grants) {
    const arr = byUser.get(g.userId) ?? [];
    arr.push(g);
    byUser.set(g.userId, arr);
  }

  const toDelete: string[] = [];
  const toRedirect: string[] = [];
  for (const [, gs] of byUser) {
    let survivor = gs[0]!;
    for (const g of gs) {
      const better = score(g) > score(survivor);
      const tieToCanonical = score(g) === score(survivor) && g.resourceId === canonicalId;
      if (better || tieToCanonical) survivor = g;
    }
    for (const g of gs) {
      if (g.id !== survivor.id) toDelete.push(g.id);
    }
    if (survivor.resourceId !== canonicalId) toRedirect.push(survivor.id);
  }

  // Delete losers FIRST so the survivor's redirect can't collide with one.
  if (toDelete.length > 0) {
    await tx.accessGrant.deleteMany({ where: { id: { in: toDelete } } });
  }
  if (toRedirect.length > 0) {
    await tx.accessGrant.updateMany({
      where: { id: { in: toRedirect } },
      data: { resourceId: canonicalId },
    });
  }
}

export interface RunCampaignMergeOptions {
  accountId?: string;
  accountName?: string;
  /** true only when --confirm was passed. false = dry-run (no writes, no synth). */
  apply: boolean;
  /** Defaults to 0.8. Clusters below this are reported but not merged. */
  minConfidence?: number;
  /** Clustering tuning knobs (CLI-overridable so we can tune without redeploy). */
  windowSize?: number;
  voteThreshold?: number;
}

type ClusterOutcome =
  | 'merged'
  | 'would-merge'
  | 'skipped'
  | 'failed'
  | 'below-confidence'
  | 'year-blocked';

// ── Year gate ────────────────────────────────────────────────────────────────
//
// A campaign = a name + a year. "Truck Season 2025" and a Truck Season under
// the 2024 folder are TWO campaigns. The year is STRUCTURAL: project folders
// live under year folders (… / 2026 / 13. Chevy | BHAC …), captured in
// campaign.drive_folder_path at creation. The detector clusters by name
// meaning only; this gate then keeps together only same-year members.
//
// Policy (locked): unknown year never merges — not with a known year, not
// with another unknown. Conservative: we can't verify "same year", so we
// don't collapse. Folder-less (phantom) campaigns therefore never merge here.

/**
 * Extract the year from a folder breadcrumb path. Only an EXACT 4-digit
 * segment counts (the year FOLDER, e.g. "… / 2026 / …") — a year embedded in
 * a title ("Holiday 2026") is the campaign's name, not its shelf location.
 * Deepest matching segment wins. Null = no structural year.
 */
export function extractYearFromPath(path: string | null): number | null {
  if (!path) return null;
  let year: number | null = null;
  for (const seg of path.split(' / ')) {
    if (/^(19|20)\d{2}$/.test(seg.trim())) year = Number(seg.trim());
  }
  return year;
}

export interface YearPartition {
  /** Same-year sub-clusters (size >= 2) that may proceed to merge. */
  subClusters: Array<DetectedCluster & { year: number }>;
  /** Member ids excluded: no structural year on their folder path. */
  droppedUnknownYear: string[];
  /** Member ids excluded: alone in their year after partitioning. */
  droppedSingleton: string[];
}

/**
 * Partition a detected cluster by member year. The detector judged the NAMES
 * to be one campaign; this decides which members share the YEAR and may
 * actually collapse. Keeps the original canonical when it lands in a
 * sub-cluster; otherwise the sub-cluster's first member (roster order —
 * detectCampaignClustersWindowed already re-derived canonicals code-side)
 * becomes canonical.
 */
export function partitionClusterByYear(
  cluster: DetectedCluster,
  yearOf: Map<string, number | null>,
): YearPartition {
  const nameOf = new Map<string, string>([
    [cluster.canonicalId, cluster.canonicalName],
    ...cluster.variantIds.map((id, i) => [id, cluster.variantNames[i] ?? '(unknown)'] as const),
  ]);
  const memberIds = [cluster.canonicalId, ...cluster.variantIds];

  const byYear = new Map<number, string[]>();
  const droppedUnknownYear: string[] = [];
  for (const id of memberIds) {
    const year = yearOf.get(id) ?? null;
    if (year === null) {
      droppedUnknownYear.push(id);
      continue;
    }
    const arr = byYear.get(year) ?? [];
    arr.push(id);
    byYear.set(year, arr);
  }

  const subClusters: Array<DetectedCluster & { year: number }> = [];
  const droppedSingleton: string[] = [];
  for (const [year, ids] of byYear) {
    if (ids.length < 2) {
      droppedSingleton.push(...ids);
      continue;
    }
    const canonicalId = ids.includes(cluster.canonicalId) ? cluster.canonicalId : ids[0]!;
    const variantIds = ids.filter((id) => id !== canonicalId);
    subClusters.push({
      canonicalId,
      canonicalName: nameOf.get(canonicalId)!,
      variantIds,
      variantNames: variantIds.map((id) => nameOf.get(id)!),
      confidence: cluster.confidence,
      reasoning: `${cluster.reasoning} [year-gate: ${year}]`,
      year,
    });
  }

  return { subClusters, droppedUnknownYear, droppedSingleton };
}

export interface ClusterReport {
  canonicalId: string;
  canonicalName: string;
  variantCount: number;
  confidence: number;
  reasoning: string;
  outcome: ClusterOutcome;
  reason?: string;
}

export interface CampaignMergeResult {
  accountId: string;
  accountName: string;
  apply: boolean;
  minConfidence: number;
  totalCampaignsScanned: number;
  clustersDetected: number;
  droppedClusterCount: number;
  variantsMergedCount: number;
  clusters: ClusterReport[];
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

async function resolveAccount(
  opts: RunCampaignMergeOptions,
): Promise<{ id: string; name: string }> {
  if (!opts.accountId && !opts.accountName) {
    throw new Error('runCampaignMerge requires accountId or accountName');
  }
  const account = opts.accountId
    ? await prisma.account.findUnique({
        where: { id: opts.accountId },
        select: { id: true, name: true },
      })
    : await prisma.account.findFirst({
        where: { name: { contains: opts.accountName!, mode: 'insensitive' } },
        select: { id: true, name: true },
      });
  if (!account) {
    throw new Error(
      `account not found (${opts.accountId ?? `name~"${opts.accountName}"`})`,
    );
  }
  return account;
}

/**
 * Apply a single cluster: re-synthesize the canonical's markdown, redirect
 * every FK referencing a variant, delete the variant rows, write audit log.
 * All in one transaction. Returns the merged variant count.
 */
async function applyCluster(
  cluster: DetectedCluster,
  account: { id: string; name: string },
): Promise<number> {
  const allIds = [cluster.canonicalId, ...cluster.variantIds];
  const rows = await prisma.campaign.findMany({
    where: { id: { in: allIds } },
    select: {
      id: true,
      accountId: true,
      name: true,
      status: true,
      budget: true,
      awardedAt: true,
      liveAt: true,
      endsAt: true,
      statusMarkdown: true,
      statusSensitiveMarkdown: true,
      driveFolderId: true,
      driveFolderUrl: true,
      driveFolderPath: true,
    },
  });

  if (rows.length !== allIds.length) {
    const missing = allIds.filter((id) => !rows.some((r) => r.id === id));
    throw new Error(`rows missing in DB: ${missing.join(', ')}`);
  }
  const canonicalRow = rows.find((r) => r.id === cluster.canonicalId);
  if (!canonicalRow) throw new Error('canonical row not found (consistency check)');
  const wrongAccount = rows.find((r) => r.accountId !== account.id);
  if (wrongAccount) {
    throw new Error(
      `row ${wrongAccount.id} belongs to a different account (${wrongAccount.accountId})`,
    );
  }

  const variantRows = rows.filter((r) => r.id !== cluster.canonicalId);
  const variantIds = variantRows.map((r) => r.id);
  const canonicalState = buildCampaignCurrentState(canonicalRow);
  const scanDay = todayYmd();
  const variantMarkdowns: VariantMarkdown[] = rows.map((r) => ({
    name: r.name,
    status: r.statusMarkdown,
    sensitive: r.statusSensitiveMarkdown,
  }));

  const merged = await mergeCampaignMarkdowns({
    canonicalName: cluster.canonicalName,
    accountName: account.name,
    canonicalState,
    scanDay,
    variantMarkdowns,
  });

  await prisma.$transaction(async (tx) => {
    // 1. Write merged markdown + bump drive_last_run_at on the canonical.
    await tx.campaign.update({
      where: { id: cluster.canonicalId },
      data: {
        statusMarkdown: merged.status,
        statusSensitiveMarkdown: merged.sensitive,
        driveLastRunAt: new Date(),
      },
    });

    // 2. Redirect FKs. campaign_changes FIRST (NOT NULL blocks the delete).
    await tx.campaignChange.updateMany({
      where: { campaignId: { in: variantIds } },
      data: { campaignId: cluster.canonicalId },
    });
    await tx.driveFileSnapshot.updateMany({
      where: { campaignId: { in: variantIds } },
      data: { campaignId: cluster.canonicalId },
    });
    await tx.driveScanLog.updateMany({
      where: { campaignId: { in: variantIds } },
      data: { campaignId: cluster.canonicalId },
    });
    await tx.driveChangeProposal.updateMany({
      where: { campaignId: { in: variantIds } },
      data: { campaignId: cluster.canonicalId },
    });
    // access_grants soft FK: resource_type='campaign'. Collapse per-user
    // collisions instead of a blind redirect (see redirectAccessGrants).
    await redirectAccessGrants(tx, cluster.canonicalId, variantIds);

    // 3. Variant folders become PIECES of the canonical. The merge collapses
    //    campaign IDENTITY, never content: each variant's populated directory
    //    holds distinct material and must keep being scanned — as a
    //    campaign_piece owned by the canonical. Must point at the CANONICAL:
    //    campaign_pieces.campaign_id is ON DELETE CASCADE, so a piece pointed
    //    at the variant would be silently destroyed by step 4's delete.
    //    Runs BEFORE the delete so a mid-tx failure can't lose the folder.
    //    findFirst guard: driveFolderId has no unique constraint; a re-merged
    //    folder must not mint a duplicate piece.
    const piecesMinted: Record<string, string> = {}; // variantId → pieceId
    for (const v of variantRows) {
      if (!v.driveFolderId) continue; // phantom (folder-less) variant — nothing to preserve
      const existing = await tx.campaignPiece.findFirst({
        where: { driveFolderId: v.driveFolderId },
        select: { id: true },
      });
      if (existing) {
        piecesMinted[v.id] = existing.id;
        continue;
      }
      const piece = await tx.campaignPiece.create({
        data: {
          campaignId: cluster.canonicalId,
          name: v.name,
          driveFolderId: v.driveFolderId,
          driveFolderUrl: v.driveFolderUrl,
          driveFolderPath: v.driveFolderPath,
        },
      });
      piecesMinted[v.id] = piece.id;
    }

    // 4. Delete variant rows.
    await tx.campaign.deleteMany({ where: { id: { in: variantIds } } });

    // 5. Audit log — one entry per merged variant.
    for (const v of variantRows) {
      await tx.auditLog.create({
        data: {
          action: 'campaign_merged',
          entityType: 'campaign',
          entityId: cluster.canonicalId,
          actorId: DRIVE_SYNC_SYSTEM_STAFF_ID,
          before: {
            mergedVariant: {
              id: v.id,
              name: v.name,
              status: v.status,
              hadStatusMarkdown: !!v.statusMarkdown,
              hadStatusSensitiveMarkdown: !!v.statusSensitiveMarkdown,
            },
          } as Prisma.InputJsonValue,
          after: {
            canonicalId: cluster.canonicalId,
            canonicalName: cluster.canonicalName,
            confidence: cluster.confidence,
            reasoning: cluster.reasoning,
            ...(piecesMinted[v.id] ? { pieceId: piecesMinted[v.id] } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    }
  });

  return variantRows.length;
}

export async function runCampaignMerge(
  opts: RunCampaignMergeOptions,
): Promise<CampaignMergeResult> {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const account = await resolveAccount(opts);

  const campaigns = await prisma.campaign.findMany({
    where: { accountId: account.id },
    select: {
      id: true,
      name: true,
      status: true,
      driveFolderId: true,
      driveFolderPath: true,
      statusMarkdown: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Year per campaign, from the structural folder path (persisted at
  // creation). Null = no year folder in the path (or path never persisted).
  const yearOf = new Map<string, number | null>(
    campaigns.map((c) => [c.id, extractYearFromPath(c.driveFolderPath)]),
  );

  logger.info(
    { accountId: account.id, accountName: account.name, campaignCount: campaigns.length, apply: opts.apply },
    '[campaign-merge] detecting duplicate clusters (sliding-window)',
  );

  const detection = await detectCampaignClustersWindowed({
    accountName: account.name,
    campaigns,
    ...(opts.windowSize !== undefined ? { windowSize: opts.windowSize } : {}),
    ...(opts.voteThreshold !== undefined ? { voteThreshold: opts.voteThreshold } : {}),
  });

  const clusterReports: ClusterReport[] = [];
  let variantsMergedCount = 0;

  for (const cluster of detection.clusters) {
    const base = {
      canonicalId: cluster.canonicalId,
      canonicalName: cluster.canonicalName,
      variantCount: cluster.variantIds.length,
      confidence: cluster.confidence,
      reasoning: cluster.reasoning,
    };

    if (cluster.confidence < minConfidence) {
      clusterReports.push({ ...base, outcome: 'below-confidence' });
      logger.info(
        { canonicalName: cluster.canonicalName, confidence: cluster.confidence, minConfidence },
        '[campaign-merge] cluster below confidence floor — skipped',
      );
      continue;
    }

    // ── Year gate: the detector matched the NAMES; only same-year members
    // may actually collapse. Unknown-year members never merge (policy).
    const partition = partitionClusterByYear(cluster, yearOf);
    if (partition.droppedUnknownYear.length > 0 || partition.droppedSingleton.length > 0) {
      logger.info(
        {
          canonicalName: cluster.canonicalName,
          droppedUnknownYear: partition.droppedUnknownYear,
          droppedSingleton: partition.droppedSingleton,
          subClusters: partition.subClusters.map((s) => ({ year: s.year, size: s.variantIds.length + 1 })),
        },
        '[campaign-merge] year gate partitioned cluster',
      );
    }
    if (partition.subClusters.length === 0) {
      clusterReports.push({
        ...base,
        outcome: 'year-blocked',
        reason: `no two members share a known year (unknown: ${partition.droppedUnknownYear.length}, singleton: ${partition.droppedSingleton.length})`,
      });
      continue;
    }

    for (const sub of partition.subClusters) {
      const subBase = {
        canonicalId: sub.canonicalId,
        canonicalName: sub.canonicalName,
        variantCount: sub.variantIds.length,
        confidence: sub.confidence,
        reasoning: sub.reasoning,
      };

      if (!opts.apply) {
        clusterReports.push({ ...subBase, outcome: 'would-merge' });
        logger.info(
          {
            canonicalName: sub.canonicalName,
            canonicalId: sub.canonicalId,
            variants: sub.variantNames,
            confidence: sub.confidence,
            year: sub.year,
          },
          '[campaign-merge] DRY-RUN would merge',
        );
        continue;
      }

      try {
        const mergedCount = await applyCluster(sub, account);
        variantsMergedCount += mergedCount;
        clusterReports.push({ ...subBase, outcome: 'merged' });
        logger.info(
          { canonicalName: sub.canonicalName, mergedCount, year: sub.year },
          '[campaign-merge] merged cluster',
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        clusterReports.push({ ...subBase, outcome: 'failed', reason });
        logger.error(
          { err, canonicalName: sub.canonicalName },
          '[campaign-merge] cluster merge failed — skipped, continuing',
        );
      }
    }
  }

  // ── Invalidate the structure cache after any applied merge. The cached
  // entityMap still classifies merged variants' folders as campaigns pointing
  // at DELETED campaign ids; a later bootstrap chunk reusing it would
  // attribute files to nonexistent campaigns. Piece anchors are overlaid
  // fresh from the DB each run, so dropping the cache is safe — the next
  // chunk re-gathers + re-classifies and picks the pieces up as anchors.
  if (opts.apply && variantsMergedCount > 0) {
    await prisma.account.update({
      where: { id: account.id },
      data: {
        driveStructureClassification: Prisma.JsonNull,
        // Files cache too: a mid-chain merge mints piece rows whose folders
        // aren't in the cached file list — a later chunk cache-HIT would
        // never gather them (and the chain would then mark bootstrap
        // complete with the piece's files never scanned).
        driveBootstrapFiles: Prisma.JsonNull,
      },
    });
    logger.info(
      { accountId: account.id },
      '[campaign-merge] structure classification cache invalidated',
    );
  }

  return {
    accountId: account.id,
    accountName: account.name,
    apply: opts.apply,
    minConfidence,
    totalCampaignsScanned: campaigns.length,
    clustersDetected: detection.clusters.length,
    droppedClusterCount: detection.droppedClusterCount,
    variantsMergedCount,
    clusters: clusterReports,
  };
}
