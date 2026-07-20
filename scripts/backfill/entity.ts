// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import { prisma } from '../../src/prisma';
import {
  buildAccountCurrentState,
  buildCampaignCurrentState,
  type AccountCurrentState,
  type CampaignCurrentState,
} from '../../src/drive/schema';
import type { Args } from './args';
import { ymdFromDate } from './days';

// ── Entity ───────────────────────────────────────────────────────────────────

export interface EntityCtx {
  type: 'account' | 'campaign';
  id: string;
  name: string;
  folderId: string;
  /**
   * The parent account id for both account- and campaign-scoped ctx —
   * the bootstrap cursor lives on `accounts.drive_bootstrap_cursor` and
   * is account-scoped regardless of which entity drove the chunk.
   */
  accountId: string;
  /** Account ROOT folder id — the org-scope external key on idea rows. */
  accountFolderId: string | null;
  accountState: AccountCurrentState;
  accountName: string;
  campaignName: string | null;
  campaignState: CampaignCurrentState | null;
  /** Current persisted status_markdown (general) or null. */
  statusMarkdown: string | null;
  /** Current persisted status_sensitive_markdown or null (per D29). */
  statusSensitiveMarkdown: string | null;
  /**
   * Persisted `accounts.drive_bootstrap_cursor` as YYYY-MM-DD, or null.
   * Drives the modifiedTime-day walker's "next pending day" lookup.
   * Written at the end of every chunk regardless of synthesis output.
   */
  driveBootstrapCursor: string | null;
  /**
   * Cached structure (folders + entity_map + fingerprint) from a prior
   * chunk. NULL = first chunk in chain, or cache invalidated. Engine
   * checks fingerprint; on match, skips the ~1m 45s LLM classify step.
   */
  driveStructureClassification: unknown;
  /**
   * Cached file list + active_dates from bootstrap chunk #1. NULL after
   * bootstrap completes (or before first chunk). When present, chunks
   * 2..N skip the ~3 min file discovery + grouping step.
   */
  driveBootstrapFiles: unknown;
  reviewerEmail: string | null;
  reviewerStaffId: string | null;
}

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
