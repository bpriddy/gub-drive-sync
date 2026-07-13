/**
 * inspect.ts — read-only topology probe. Answers "what does this account
 * actually look like in the DB + in Drive?" without touching anything.
 *
 * Built to ground the pieces work: before deriving campaign_pieces we need to
 * SEE whether a campaign's deliverables live as nested sub-folders, as sibling
 * folders that got split into their own campaign rows, or only in content. It
 * loads the account's campaign rows (DB truth) and walks the folder tree
 * (Drive), annotating which folders are campaign roots — so nested-vs-sibling
 * is visible at a glance. No LLM, no writes.
 */

import { prisma } from '../prisma';
import { logger } from '../logger';
import { gatherFolders, type FolderNode } from './structure';

export interface InspectCampaign {
  id: string;
  name: string;
  driveFolderId: string | null;
  /** True when this campaign's driveFolderId appears in the walked tree. */
  foundInTree: boolean;
}

export interface InspectTreeNode {
  depth: number;
  name: string;
  id: string;
  parentId: string | null;
  /** Campaign name when this folder id is a campaign root, else null. */
  campaignRoot: string | null;
}

export interface InspectResult {
  accountName: string;
  accountRootFolderId: string;
  gatherRootFolderId: string;
  gatherRootLabel: string;
  campaignCount: number;
  campaigns: InspectCampaign[];
  folderCount: number;
  tree: InspectTreeNode[];
  /** Human-readable indented tree with [CAMPAIGN: …] markers, for the log. */
  renderedTree: string;
}

export async function inspectStructure(args: {
  accountName?: string;
  accountId?: string;
  campaignName?: string;
  folderId?: string;
}): Promise<InspectResult> {
  const account =
    args.accountId || args.accountName
      ? await prisma.account.findFirst({
          where: args.accountId
            ? { id: args.accountId }
            : { name: { contains: args.accountName!, mode: 'insensitive' } },
          select: { id: true, name: true, driveFolderId: true },
        })
      : null;
  if (!account) throw new Error('account not found — pass --account-name or --account-id');
  if (!account.driveFolderId) throw new Error(`account "${account.name}" has no drive_folder_id`);

  const campaignRows = await prisma.campaign.findMany({
    where: { accountId: account.id },
    select: { id: true, name: true, driveFolderId: true },
    orderBy: { name: 'asc' },
  });

  // Choose the gather root: an explicit folder, a named campaign's folder, or
  // the whole account root (default — the only way to see sibling campaigns).
  let gatherRoot = account.driveFolderId;
  let gatherLabel = account.name;
  if (args.folderId) {
    gatherRoot = args.folderId;
    gatherLabel = `${account.name} / (folder ${args.folderId})`;
  } else if (args.campaignName) {
    const c = campaignRows.find((r) =>
      r.name.toLowerCase().includes(args.campaignName!.toLowerCase()),
    );
    if (c?.driveFolderId) {
      gatherRoot = c.driveFolderId;
      gatherLabel = `${account.name} / ${c.name}`;
    } else {
      logger.warn(
        { campaignName: args.campaignName },
        '[drive.inspect] no campaign row matched --campaign-name — walking account root',
      );
    }
  }

  const folders = await gatherFolders(gatherRoot, gatherLabel);

  const campaignByFolderId = new Map<string, string>();
  for (const c of campaignRows) if (c.driveFolderId) campaignByFolderId.set(c.driveFolderId, c.name);

  const seenFolderIds = new Set(folders.map((f) => f.id));
  const campaigns: InspectCampaign[] = campaignRows.map((c) => ({
    id: c.id,
    name: c.name,
    driveFolderId: c.driveFolderId,
    foundInTree: c.driveFolderId ? seenFolderIds.has(c.driveFolderId) : false,
  }));

  const tree: InspectTreeNode[] = folders.map((f: FolderNode) => ({
    depth: f.depth,
    name: f.name,
    id: f.id,
    parentId: f.parentId,
    campaignRoot: campaignByFolderId.get(f.id) ?? null,
  }));

  const renderedTree = [
    `${gatherLabel}/  [${gatherRoot}]  (gather root)`,
    ...tree.map((n) => {
      const indent = '  '.repeat(n.depth);
      const marker = n.campaignRoot ? `   ⟵ [CAMPAIGN: ${n.campaignRoot}]` : '';
      return `${indent}${n.name}/  [${n.id}]${marker}`;
    }),
  ].join('\n');

  logger.info(
    { accountName: account.name, campaignCount: campaignRows.length, folderCount: folders.length, gatherRoot },
    '[drive.inspect] complete',
  );

  return {
    accountName: account.name,
    accountRootFolderId: account.driveFolderId,
    gatherRootFolderId: gatherRoot,
    gatherRootLabel: gatherLabel,
    campaignCount: campaignRows.length,
    campaigns,
    folderCount: folders.length,
    tree,
    renderedTree,
  };
}
