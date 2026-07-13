/**
 * drive.structure.ts — Stage 1: account folder-tree → entity map.
 *
 * The pipeline can't reliably say which campaign a file belongs to without
 * first understanding the account's folder topology — which is NOT uniform
 * ("children of the account = campaigns" breaks the moment there's a master
 * project folder or any nesting). This module resolves that topology once
 * per account scan, BEFORE any file content is touched.
 *
 * Approach:
 *   1. Folders-only walk of the account tree (cheap — no file downloads).
 *   2. Anchor on existing campaigns (their drive_folder_id is fixed truth;
 *      the LLM doesn't get to re-decide them — it only reasons about the
 *      unmapped remainder). Keeps the map stable scan-to-scan.
 *   3. Feed the tree + anchors to an LLM, which classifies folders as
 *      existing_campaign / new_campaign / account_level.
 *
 * The result is an attribution map ONLY. It does not emit semantic signals
 * (archive detection, moves, etc.) — those were explicitly scoped out (see
 * docs/status-markdown-plan.md). Its single job: "which entity owns this
 * file?" Anything not classified as a campaign root is account-level by
 * default — nothing is ignored.
 *
 * Stage 1 status: the prompt is hardcoded INLINE here (not in prompt_presets)
 * for fast iteration during validation. When the structure read is trusted
 * and we wire it into production extraction (Stage 2+), it can move to a
 * preset like the other extraction prompts — or stay here. Not decided yet.
 */

import { z } from 'zod';
import { logger } from '../logger';
import { defaultLlm, parseLlmJson } from '../ai';
import { listAllFoldersInDrive, listSubfolders, probeFolder, type DriveFolderRec } from './client';
import { structureResolutionResponseSchema } from './structured-output';

// Folders are shallow in practice; this is a defense-in-depth rail against
// an infinite-recursion bug, matching traversal.ts's cap.
const MAX_DEPTH = 100;

const STRUCTURE_MODEL = 'gemini-3.5-flash';
const STRUCTURE_TEMPERATURE = 0.2;
export const STRUCTURE_RESOLUTION_VERSION = 'drive.structure_resolution.v1-inline';

// ── Public types ─────────────────────────────────────────────────────────────

export interface FolderNode {
  id: string;
  name: string;
  /** Breadcrumb path from the account root, e.g. "Chevy / Master / Silverado". */
  path: string;
  depth: number;
  /**
   * Immediate parent folder id, or null when this folder's parent IS the
   * account root (we treat the root as boundary, not a FolderNode). Used
   * by `buildAttributor` to walk up to the nearest campaign-root ancestor.
   */
  parentId: string | null;
}

export type FolderClassification = 'existing_campaign' | 'new_campaign' | 'account_level';

export interface ClassifiedFolder {
  folderId: string;
  folderPath: string;
  classification: FolderClassification;
  /** Campaign name for campaign classifications; null for account_level. */
  campaignName: string | null;
  /** For existing_campaign only: the matched DB campaign id. */
  matchedCampaignId: string | null;
  reasoning: string;
}

export interface ExistingCampaignAnchor {
  id: string;
  name: string;
  driveFolderId: string;
}

export interface EntityMap {
  accountId: string;
  accountName: string;
  /** Every folder walked (folders-only), for reference + default attribution. */
  allFolders: FolderNode[];
  /** The LLM's classification of significant folders. */
  classified: ClassifiedFolder[];
  driver: string;
  /** Total folders walked. */
  folderCount: number;
}

// ── LLM response validation ──────────────────────────────────────────────────

const ClassifiedFolderSchema = z.object({
  folder_id: z.string(),
  folder_path: z.string(),
  classification: z.enum(['existing_campaign', 'new_campaign', 'account_level']),
  campaign_name: z.string().nullable().optional(),
  matched_campaign_id: z.string().nullable().optional(),
  reasoning: z.string(),
});

const StructureResponseSchema = z.object({
  folders: z.array(ClassifiedFolderSchema).default([]),
});

// ── Folders-only gather ──────────────────────────────────────────────────────

/**
 * Gather the account's folder skeleton, choosing the cheap path when
 * possible:
 *   - Shared-drive root  → ONE flat paginated sweep of all folders, then
 *     reconstruct the tree in memory. O(folders/200) API calls.
 *   - Folder inside a drive / My Drive → recursive per-folder walk.
 *     O(folders) sequential calls (slow, but the only option there).
 *
 * Returns folder nodes with breadcrumb paths + depth, depth-first ordered.
 */
export interface GatherFoldersOptions {
  /** Called with the running folder count as the sweep/walk progresses. */
  onProgress?: (countSoFar: number) => void;
}

export async function gatherFolders(
  rootFolderId: string,
  rootLabel: string,
  opts: GatherFoldersOptions = {},
): Promise<FolderNode[]> {
  const probe = await probeFolder(rootFolderId);
  if (probe.isSharedDriveRoot && probe.driveId) {
    const flat = await listAllFoldersInDrive(probe.driveId, {
      ...(opts.onProgress ? { onPage: opts.onProgress } : {}),
    });
    return buildTreeFromFlat(rootFolderId, rootLabel, flat);
  }
  return walkFoldersRecursive(rootFolderId, rootLabel, opts.onProgress);
}

/**
 * Reconstruct a depth-first folder tree from a flat folder list (each with
 * an immediate parentId). Cycle-safe (visited set) and depth-capped.
 */
function buildTreeFromFlat(
  rootId: string,
  rootLabel: string,
  flat: DriveFolderRec[],
): FolderNode[] {
  const childrenByParent = new Map<string, DriveFolderRec[]>();
  for (const f of flat) {
    const p = f.parentId ?? '';
    const bucket = childrenByParent.get(p);
    if (bucket) bucket.push(f);
    else childrenByParent.set(p, [f]);
  }

  const out: FolderNode[] = [];
  const visited = new Set<string>();

  const descend = (parentFolderId: string, parentPath: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const kids = childrenByParent.get(parentFolderId) ?? [];
    for (const k of kids) {
      if (visited.has(k.id)) continue; // defensive against multi-parent / cycles
      visited.add(k.id);
      const path = `${parentPath} / ${k.name}`;
      // parentId is the FolderNode parent — null when the parent is the
      // account root itself (we don't model the root as a FolderNode).
      const parentIdField = parentFolderId === rootId ? null : parentFolderId;
      out.push({ id: k.id, name: k.name, path, depth: depth + 1, parentId: parentIdField });
      descend(k.id, path, depth + 1);
    }
  };

  descend(rootId, rootLabel, 0);
  return out;
}

/**
 * Recursive folders-only walk — fallback for non-shared-drive roots, where
 * the flat `corpora=drive` sweep isn't available. Subfolder errors are
 * swallowed (one unreadable subfolder shouldn't tank the whole read).
 */
async function walkFoldersRecursive(
  rootFolderId: string,
  rootLabel: string,
  onProgress?: (countSoFar: number) => void,
): Promise<FolderNode[]> {
  const out: FolderNode[] = [];

  async function recurse(folderId: string, folderPath: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      logger.debug({ folderId, folderPath, depth }, '[drive.structure] folder depth cap hit');
      return;
    }
    let subs: Awaited<ReturnType<typeof listSubfolders>>;
    try {
      subs = await listSubfolders(folderId);
    } catch (err) {
      if (depth === 0) throw err;
      logger.debug({ err, folderId, folderPath }, '[drive.structure] subfolder list failed — skipping');
      return;
    }
    for (const sub of subs) {
      const subPath = `${folderPath} / ${sub.name}`;
      // parentId is null when the immediate parent IS the account root.
      const parentIdField = folderId === rootFolderId ? null : folderId;
      out.push({ id: sub.id, name: sub.name, path: subPath, depth: depth + 1, parentId: parentIdField });
      if (onProgress) onProgress(out.length);
      await recurse(sub.id, subPath, depth + 1);
    }
  }

  await recurse(rootFolderId, rootLabel, 0);
  return out;
}

// ── Tree rendering for the prompt ────────────────────────────────────────────

function renderTree(rootLabel: string, rootFolderId: string, folders: FolderNode[]): string {
  const lines = [`${rootLabel}/  [id: ${rootFolderId}]  (account root)`];
  for (const f of folders) {
    const indent = '  '.repeat(f.depth);
    lines.push(`${indent}${f.name}/  [id: ${f.id}]`);
  }
  return lines.join('\n');
}

function renderExistingCampaigns(anchors: ExistingCampaignAnchor[]): string {
  if (anchors.length === 0) {
    return '(none — this account has no campaigns in the DB yet; every campaign folder you find is a new_campaign)';
  }
  return anchors
    .map((a) => `- "${a.name}"  → folder id ${a.driveFolderId}  (campaign id: ${a.id})`)
    .join('\n');
}

// ── Prompt (hardcoded inline for Stage 1 iteration) ──────────────────────────

function buildPrompt(args: {
  accountName: string;
  rootFolderId: string;
  folders: FolderNode[];
  anchors: ExistingCampaignAnchor[];
}): string {
  const tree = renderTree(args.accountName, args.rootFolderId, args.folders);
  const existing = renderExistingCampaigns(args.anchors);

  return `You are mapping the folder topology of an agency account's Google Drive so the sync pipeline knows which campaign each file belongs to.

ACCOUNT: ${args.accountName}

A CAMPAIGN is a discrete project, initiative, or engagement for this client — a product launch, a pitch, a seasonal push, a specific deliverable program. Each campaign owns a folder (its "root"); everything under that folder belongs to the campaign.

EXISTING CAMPAIGNS (already in the DB — fixed truth, do not re-decide):
${existing}

FOLDER TREE (folders only — files omitted):
${tree}

TASK
  Classify the SIGNIFICANT folders. For each, return:
    - folder_id, folder_path (copy verbatim from the tree)
    - classification: one of
        existing_campaign  — this folder is the root of a campaign listed in EXISTING CAMPAIGNS. Set matched_campaign_id to that campaign's id and campaign_name to its name. You MUST classify every existing campaign's folder this way.
        new_campaign       — this folder is the root of a campaign NOT yet in the DB. Set campaign_name (clean folder name).
        account_level      — account-wide material not specific to a single campaign.
    - reasoning: one sentence.

RULES
  1. Only classify a folder as a campaign if it is the ROOT of that campaign's material. Do NOT classify sub-folders WITHIN a campaign (e.g. "Creative", "Decks", "Assets" inside a campaign folder) as separate campaigns — they belong to the enclosing campaign. Return only the campaign root.
  2. Campaigns are often nested under an organizing folder. A "Master Project", "Projects", "Work", or year folder that merely CONTAINS campaigns is itself account_level (or skip it) — the real campaigns are the folders inside it. Do not mistake the organizing folder for one big campaign.
  3. account_level covers: brand assets, fonts, logos, contacts, master briefs, reference material, and AGENCY-INTERNAL folders (templates, capabilities decks, SOPs, training, team/role docs). Agency-internal folders are NEVER campaigns — they describe how the agency works, not a client project. (Same principle as the file-extraction agency filter.)
  4. You do NOT need to return an entry for every folder. Surface campaign roots (existing + new) and notable account-level collections. Folders you omit are treated as account_level by default and still get scanned — so when unsure whether a folder is a campaign, leave it out rather than inventing a campaign.
  5. Bias toward NOT inventing campaigns. A new_campaign should look like a real, nameable client initiative — not a loose folder, a scratch area, or an organizing container. When in doubt, omit (→ account_level).

Return the classified folders.`;
}

// ── Public entrypoint ────────────────────────────────────────────────────────

/**
 * Resolve in one shot: gather folders, then classify. Production callers
 * use this. The dry-run calls gatherFolders + classifyFolders separately
 * so it can print the tree between the (fast) gather and the (slower) LLM
 * classification.
 */
export async function resolveStructure(args: {
  accountId: string;
  accountName: string;
  rootFolderId: string;
  existingCampaigns: ExistingCampaignAnchor[];
}): Promise<EntityMap> {
  const folders = await gatherFolders(args.rootFolderId, args.accountName);
  logger.info(
    { accountId: args.accountId, folderCount: folders.length },
    `[drive.structure] gathered ${folders.length} folders — classifying with LLM…`,
  );
  return classifyFolders({
    accountId: args.accountId,
    accountName: args.accountName,
    rootFolderId: args.rootFolderId,
    folders,
    existingCampaigns: args.existingCampaigns,
  });
}

/**
 * Classify an already-gathered folder set into the entity map. Separated
 * from gatherFolders so callers can render/inspect the tree before paying
 * for the LLM call.
 */
export async function classifyFolders(args: {
  accountId: string;
  accountName: string;
  rootFolderId: string;
  folders: FolderNode[];
  existingCampaigns: ExistingCampaignAnchor[];
}): Promise<EntityMap> {
  const folders = args.folders;

  // No subfolders at all → trivial map (everything is account-level).
  if (folders.length === 0) {
    return {
      accountId: args.accountId,
      accountName: args.accountName,
      allFolders: [],
      classified: [],
      driver: 'n/a',
      folderCount: 0,
    };
  }

  const prompt = buildPrompt({
    accountName: args.accountName,
    rootFolderId: args.rootFolderId,
    folders,
    anchors: args.existingCampaigns,
  });

  const completion = await defaultLlm.complete({
    model: STRUCTURE_MODEL,
    temperature: STRUCTURE_TEMPERATURE,
    prompt,
    tag: STRUCTURE_RESOLUTION_VERSION,
    responseSchema: structureResolutionResponseSchema(),
  });

  let parsed: z.infer<typeof StructureResponseSchema>;
  try {
    const raw = parseLlmJson<unknown>(completion.text);
    parsed = StructureResponseSchema.parse(raw);
  } catch (err) {
    logger.error(
      { err, accountId: args.accountId, raw: completion.text.slice(0, 400) },
      '[drive.structure] response parse failed',
    );
    throw err;
  }

  // Validate matched_campaign_id references against the anchor set, and
  // backfill campaign_name for existing matches. A hallucinated id gets
  // demoted to new_campaign (we trust the folder-is-a-campaign signal but
  // not the bogus match) so it surfaces for review rather than silently
  // attaching to the wrong campaign.
  const anchorById = new Map(args.existingCampaigns.map((a) => [a.id, a]));
  const anchorByFolderId = new Map(args.existingCampaigns.map((a) => [a.driveFolderId, a]));

  const classified: ClassifiedFolder[] = parsed.folders.map((f) => {
    let classification: FolderClassification = f.classification;
    let matchedCampaignId = f.matched_campaign_id ?? null;
    let campaignName = f.campaign_name ?? null;

    if (classification === 'existing_campaign') {
      // Prefer matching by folder id (deterministic) over the LLM's claimed id.
      const byFolder = anchorByFolderId.get(f.folder_id);
      if (byFolder) {
        matchedCampaignId = byFolder.id;
        campaignName = byFolder.name;
      } else if (matchedCampaignId && anchorById.has(matchedCampaignId)) {
        campaignName = anchorById.get(matchedCampaignId)!.name;
      } else {
        // Claimed existing but no valid anchor → demote to new_campaign.
        logger.warn(
          { folderId: f.folder_id, claimedId: f.matched_campaign_id },
          '[drive.structure] existing_campaign with no valid anchor — demoting to new_campaign',
        );
        classification = 'new_campaign';
        matchedCampaignId = null;
      }
    } else {
      matchedCampaignId = null;
    }

    return {
      folderId: f.folder_id,
      folderPath: f.folder_path,
      classification,
      campaignName,
      matchedCampaignId,
      reasoning: f.reasoning,
    };
  });

  return {
    accountId: args.accountId,
    accountName: args.accountName,
    allFolders: folders,
    classified,
    driver: completion.driver,
    folderCount: folders.length,
  };
}

// ── Attribution: file's parent folder → owning entity ────────────────────────

export interface EntityAttribution {
  ownerType: 'account' | 'campaign';
  /** Campaign-root folder id (the bucketing key for campaigns). Null for account. */
  campaignFolderId: string | null;
  /** Campaign name (existing or new). Null for account. */
  campaignName: string | null;
  /** For existing_campaign owners only: the matched DB campaign id. */
  matchedCampaignId: string | null;
  /**
   * Whether the campaign is an existing DB row or a new candidate the
   * structure scan surfaced. Null when ownerType=account.
   */
  campaignStatus: 'existing' | 'new' | null;
  /**
   * Set when the campaign-root ancestor is a PIECE folder (campaign_pieces):
   * the file belongs to this piece, whose content rolls up to the owning
   * campaign (matchedCampaignId). Null for plain campaign/account attribution.
   */
  pieceId: string | null;
  pieceName: string | null;
  pieceFolderId: string | null;
}

export type Attributor = (
  parentFolderId: string | null | undefined,
) => EntityAttribution;

/**
 * Build a function that maps a file's immediate parent folder id to its
 * owning entity by walking up the parent chain in the gathered folder
 * tree, returning the FIRST campaign-root ancestor it finds. If no
 * campaign-root is found on the way up to the account root, the file is
 * attributed to the account.
 *
 * Files whose parent folder is unknown to the map (orphaned, or in a
 * subtree the gather skipped) safely default to account-level — we'd
 * rather over-attribute to account than mis-attribute to a campaign.
 */
// ── Piece anchors: pin merged-variant folders to their owning campaign ──────
//
// When the campaign merge collapses a duplicate, the variant's folder becomes
// a campaign_piece of the canonical — the folder keeps being scanned; only the
// campaign identity collapsed. But the structure classifier anchors ONLY on
// live campaign rows, so a merged variant's folder would be re-classified as a
// fresh new_campaign on the next scan (the re-split bug). This overlay pins
// piece folders deterministically from DB truth: drop whatever the LLM said
// about them and inject an existing_campaign classification pointing at the
// OWNING campaign, so attribution routes their files into the canonical.
//
// Applied at attributor-build time, NOT persisted into the structure cache —
// pieces change between runs (new merges), so each run overlays fresh.

export interface PieceAnchor {
  driveFolderId: string;
  campaignId: string;
  campaignName: string;
  /** The campaign_pieces row id — attribution reports it so files under this
   *  folder bucket to the PIECE (fine detail), rolling up to the campaign. */
  pieceId: string;
  pieceName: string;
}

export function overlayPieceAnchors(map: EntityMap, pieces: PieceAnchor[]): EntityMap {
  if (pieces.length === 0) return map;
  const pieceByFolderId = new Map(pieces.map((p) => [p.driveFolderId, p]));
  const pathByFolderId = new Map(map.allFolders.map((f) => [f.id, f.path]));

  const kept = map.classified.filter((c) => !pieceByFolderId.has(c.folderId));
  const injected: ClassifiedFolder[] = pieces
    // Only anchor folders that exist in this walked tree (a piece folder from
    // another account/subtree shouldn't inject a dangling classification).
    .filter((p) => pathByFolderId.has(p.driveFolderId))
    .map((p) => ({
      folderId: p.driveFolderId,
      folderPath: pathByFolderId.get(p.driveFolderId)!,
      classification: 'existing_campaign' as const,
      campaignName: p.campaignName,
      matchedCampaignId: p.campaignId,
      reasoning: 'piece anchor — folder owned by this campaign via campaign_pieces',
    }));

  return { ...map, classified: [...kept, ...injected] };
}

export function buildAttributor(map: EntityMap, pieces: PieceAnchor[] = []): Attributor {
  const folderById = new Map<string, FolderNode>();
  for (const f of map.allFolders) folderById.set(f.id, f);

  const classifiedByFolderId = new Map<string, ClassifiedFolder>();
  for (const c of map.classified) classifiedByFolderId.set(c.folderId, c);

  const pieceByFolderId = new Map(pieces.map((p) => [p.driveFolderId, p]));

  const accountAttribution: EntityAttribution = {
    ownerType: 'account',
    campaignFolderId: null,
    campaignName: null,
    matchedCampaignId: null,
    campaignStatus: null,
    pieceId: null,
    pieceName: null,
    pieceFolderId: null,
  };

  return (parentFolderId) => {
    if (!parentFolderId) return accountAttribution;

    let currentId: string | null | undefined = parentFolderId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const classification = classifiedByFolderId.get(currentId);
      if (
        classification &&
        (classification.classification === 'existing_campaign' ||
          classification.classification === 'new_campaign')
      ) {
        // When the campaign-root ancestor is a PIECE folder (overlaid from
        // campaign_pieces), the file belongs to that piece — fine detail
        // buckets there; the campaign identity is the piece's owner.
        const piece = pieceByFolderId.get(currentId) ?? null;
        return {
          ownerType: 'campaign',
          campaignFolderId: currentId,
          campaignName: classification.campaignName,
          matchedCampaignId: classification.matchedCampaignId,
          campaignStatus:
            classification.classification === 'existing_campaign' ? 'existing' : 'new',
          pieceId: piece?.pieceId ?? null,
          pieceName: piece?.pieceName ?? null,
          pieceFolderId: piece ? currentId : null,
        };
      }
      const folder = folderById.get(currentId);
      currentId = folder?.parentId ?? null;
    }

    return accountAttribution;
  };
}

