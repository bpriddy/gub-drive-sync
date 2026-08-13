// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import { prisma } from '../prisma';
import { buildAccountCurrentState, buildCampaignCurrentState } from '../drive/schema';
import type { EntityCtx } from '../scan/batch-types';
import type { Args } from './args';

export type { EntityCtx } from '../scan/batch-types';
import { ymdFromDate } from './days';

// ── Entity ───────────────────────────────────────────────────────────────────


export async function loadEntity(args: Args): Promise<EntityCtx> {
  if (args.accountId) {
    const a = await prisma.account.findUniqueOrThrow({
      where: { id: args.accountId },
      include: { owner: { select: { id: true, email: true } } },
    });
    if (!a.driveFolderId) throw new Error(`Account ${a.name} has no drive_folder_id`);
    return {
      type: 'account',
      id: a.id,
      name: a.name,
      folderId: a.driveFolderId,
      accountId: a.id,
      accountFolderId: a.driveFolderId,
      accountState: buildAccountCurrentState(a),
      accountName: a.name,
      campaignName: null,
      campaignState: null,
      statusMarkdown: a.statusMarkdown ?? null,
      statusSensitiveMarkdown: a.statusSensitiveMarkdown ?? null,
      driveBootstrapCursor: ymdFromDate(a.driveBootstrapCursor),
      driveStructureClassification: a.driveStructureClassification,
      driveBootstrapFiles: a.driveBootstrapFiles,
      reviewerEmail: a.owner?.email ?? null,
      reviewerStaffId: a.owner?.id ?? null,
    };
  }
  const c = await prisma.campaign.findUniqueOrThrow({
    where: { id: args.campaignId! },
    include: { account: { include: { owner: { select: { id: true, email: true } } } } },
  });
  if (!c.driveFolderId) throw new Error(`Campaign ${c.name} has no drive_folder_id`);
  return {
    type: 'campaign',
    id: c.id,
    name: c.name,
    folderId: c.driveFolderId,
    accountId: c.account.id,
    accountFolderId: c.account.driveFolderId ?? null,
    accountState: buildAccountCurrentState(c.account),
    accountName: c.account.name,
    campaignName: c.name,
    campaignState: buildCampaignCurrentState(c),
    statusMarkdown: c.statusMarkdown ?? null,
    statusSensitiveMarkdown: c.statusSensitiveMarkdown ?? null,
    driveBootstrapCursor: ymdFromDate(c.account.driveBootstrapCursor),
    driveStructureClassification: c.account.driveStructureClassification,
    driveBootstrapFiles: c.account.driveBootstrapFiles,
    reviewerEmail: c.account.owner?.email ?? null,
    reviewerStaffId: c.account.owner?.id ?? null,
  };
}
