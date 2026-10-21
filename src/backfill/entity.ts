// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { buildAccountCurrentState, buildCampaignCurrentState } from '../drive/schema';
import type { EntityCtx } from '../scan/batch-types';
import type { Args } from './args';

export type { EntityCtx } from '../scan/batch-types';
import { ymdFromDate } from './days';

// ── Entity ───────────────────────────────────────────────────────────────────

/**
 * Every Account scalar EXCEPT drive_bootstrap_files. That column is the files
 * cache — one JSONB that grows with the drive (~19 MiB at 26k files) — and it
 * must not ride along with every loadEntity call: structure-only and forward
 * runs never use it, and the bootstrap path reads it lazily through
 * loadBootstrapFilesCache (days.ts).
 *
 * Prisma 5's `omit` is a preview feature that has to be enabled in the
 * generator block, which lives in the shared gub-schemas package, so this
 * selects the complement instead. It is derived from the generated scalar
 * enum, not typed out: a column added to Account later is then loaded
 * automatically, where a hand-written list would silently stop loading it.
 */
const ACCOUNT_SCALARS_WITHOUT_FILES_CACHE = Object.fromEntries(
  Object.values(Prisma.AccountScalarFieldEnum)
    .filter((field) => field !== 'driveBootstrapFiles')
    .map((field) => [field, true] as const),
) as { [K in Exclude<Prisma.AccountScalarFieldEnum, 'driveBootstrapFiles'>]: true };

const ACCOUNT_CTX_SELECT = {
  ...ACCOUNT_SCALARS_WITHOUT_FILES_CACHE,
  owner: { select: { id: true, email: true } },
} satisfies Prisma.AccountSelect;

export async function loadEntity(args: Args): Promise<EntityCtx> {
  if (args.accountId) {
    const a = await prisma.account.findUniqueOrThrow({
      where: { id: args.accountId },
      select: ACCOUNT_CTX_SELECT,
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
      reviewerEmail: a.owner?.email ?? null,
      reviewerStaffId: a.owner?.id ?? null,
    };
  }
  const c = await prisma.campaign.findUniqueOrThrow({
    where: { id: args.campaignId! },
    include: { account: { select: ACCOUNT_CTX_SELECT } },
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
    reviewerEmail: c.account.owner?.email ?? null,
    reviewerStaffId: c.account.owner?.id ?? null,
  };
}
