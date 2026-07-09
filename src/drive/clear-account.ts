/**
 * clear-account.ts — COMPLETE per-account Drive-sync nuke ("clean slate").
 *
 * Wipes every trace of Drive-sync state for one account so a re-bootstrap
 * starts from a truly blank slate. The account row itself SURVIVES (its
 * drive_folder_id / business fields are kept) — only its sync state + all
 * child data are removed.
 *
 * This supersedes the old clear.ts `--account-id` path, which left four kinds
 * of residue that silently break a re-bootstrap (audited 2026-06-25):
 *   - drive_structure_classification (account col) → "structure cache HIT"
 *     skips the fresh folder classify. THE big one — it deliberately survives
 *     bootstrap completion.
 *   - drive_bootstrap_files (account col) → "files cache HIT" skips discovery.
 *   - drive_file_snapshots (table) → forward-sync delta-skip skips files.
 *   - drive_sync_runs (queue) → a pending/running row blocks re-trigger (409).
 *
 * DELETES (all scoped to the account + its campaigns):
 *   drive_change_proposals, drive_scan_logs, drive_file_snapshots,
 *   drive_sync_runs, campaign_changes, campaigns, account_changes,
 *   access_grants (account- AND campaign-scoped), audit_log (Chevy entries).
 * RESETS account cols → NULL:
 *   status_markdown, status_sensitive_markdown, drive_bootstrap_cursor,
 *   drive_bootstrap_completed_at, drive_last_synced_at, drive_activity_page_token,
 *   drive_structure_classification, drive_bootstrap_files, drive_last_run_at.
 * KEEPS: drive_folder_id/url/path + all business columns.
 *
 * audit_log purge & production strictness: the whole nuke is ONE transaction.
 * In DEV the audit_log immutability triggers are dropped
 * (20240126_disable_append_only_triggers), so the audit_log delete succeeds.
 * When PROD re-enables those triggers, the delete raises
 * `restrict_violation` and the ENTIRE transaction rolls back atomically —
 * production stays strict, enforced by the database, not by a config flag
 * (NODE_ENV is 'production' on the deployed dev job, so it can't gate this).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../logger';

export interface ClearAccountOptions {
  accountId?: string;
  accountName?: string;
  /** true only when --confirm was passed. false = dry-run (count only, no writes). */
  apply: boolean;
}

export interface ClearAccountResult {
  accountId: string;
  accountName: string;
  apply: boolean;
  counts: {
    campaigns: number;
    accessGrants: number;
    driveChangeProposals: number;
    driveScanLogs: number;
    driveFileSnapshots: number;
    driveSyncRuns: number;
    campaignChanges: number;
    accountChanges: number;
    auditLogEntries: number;
  };
}

async function resolveAccount(
  opts: ClearAccountOptions,
): Promise<{ id: string; name: string }> {
  if (!opts.accountId && !opts.accountName) {
    throw new Error('clearAccount requires accountId or accountName');
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

export async function clearAccountComplete(
  opts: ClearAccountOptions,
): Promise<ClearAccountResult> {
  const account = await resolveAccount(opts);

  // ── Collect the id sets we need for scoping + audit purge. ──────────────
  const campaigns = await prisma.campaign.findMany({
    where: { accountId: account.id },
    select: { id: true },
  });
  const campaignIds = campaigns.map((c) => c.id);

  // All Chevy grants: account-scoped + campaign-scoped (polymorphic soft FK).
  const grants = await prisma.accessGrant.findMany({
    where: {
      OR: [
        { resourceType: 'account', resourceId: account.id },
        { resourceType: 'campaign', resourceId: { in: campaignIds } },
      ],
    },
    select: { id: true },
  });
  const grantIds = grants.map((g) => g.id);

  // Counts (also the dry-run report). Cheap targeted counts.
  const [proposals, scanLogs, snapshots, syncRuns, campaignChanges, accountChanges, auditEntries] =
    await Promise.all([
      prisma.driveChangeProposal.count({
        where: { OR: [{ accountId: account.id }, { campaignId: { in: campaignIds } }] },
      }),
      prisma.driveScanLog.count({
        where: { OR: [{ accountId: account.id }, { campaignId: { in: campaignIds } }] },
      }),
      prisma.driveFileSnapshot.count({
        where: { OR: [{ accountId: account.id }, { campaignId: { in: campaignIds } }] },
      }),
      prisma.driveSyncRun.count({ where: { accountId: account.id } }),
      prisma.campaignChange.count({ where: { campaignId: { in: campaignIds } } }),
      prisma.accountChange.count({ where: { accountId: account.id } }),
      prisma.auditLog.count({
        where: {
          OR: [
            { entityType: 'campaign', entityId: { in: campaignIds } },
            { entityType: 'account', entityId: account.id },
            { entityType: 'access_grant', entityId: { in: grantIds } },
          ],
        },
      }),
    ]);

  const counts: ClearAccountResult['counts'] = {
    campaigns: campaignIds.length,
    accessGrants: grantIds.length,
    driveChangeProposals: proposals,
    driveScanLogs: scanLogs,
    driveFileSnapshots: snapshots,
    driveSyncRuns: syncRuns,
    campaignChanges,
    accountChanges,
    auditLogEntries: auditEntries,
  };

  logger.info(
    { accountId: account.id, accountName: account.name, apply: opts.apply, counts },
    opts.apply
      ? '[clear-account] APPLYING complete nuke'
      : '[clear-account] DRY-RUN — would delete/reset the following',
  );

  if (!opts.apply) {
    return { accountId: account.id, accountName: account.name, apply: false, counts };
  }

  // ── Single transaction. Order respects the RESTRICT FKs (campaign_changes
  //    before campaigns). All-or-nothing: in prod the audit_log delete hits
  //    the immutability trigger and rolls the whole thing back. ────────────
  await prisma.$transaction(
    async (tx) => {
      await tx.driveChangeProposal.deleteMany({
        where: { OR: [{ accountId: account.id }, { campaignId: { in: campaignIds } }] },
      });
      await tx.driveScanLog.deleteMany({
        where: { OR: [{ accountId: account.id }, { campaignId: { in: campaignIds } }] },
      });
      await tx.driveFileSnapshot.deleteMany({
        where: { OR: [{ accountId: account.id }, { campaignId: { in: campaignIds } }] },
      });
      await tx.driveSyncRun.deleteMany({ where: { accountId: account.id } });
      // campaign_changes → campaigns FK is RESTRICT: delete children first.
      await tx.campaignChange.deleteMany({ where: { campaignId: { in: campaignIds } } });
      await tx.campaign.deleteMany({ where: { accountId: account.id } });
      await tx.accountChange.deleteMany({ where: { accountId: account.id } });
      // access_grants has no FK on resource_id — delete explicitly by id.
      await tx.accessGrant.deleteMany({ where: { id: { in: grantIds } } });
      // audit_log purge — succeeds in dev (triggers dropped), atomically
      // rolls the whole nuke back in prod (triggers block delete).
      await tx.auditLog.deleteMany({
        where: {
          OR: [
            { entityType: 'campaign', entityId: { in: campaignIds } },
            { entityType: 'account', entityId: account.id },
            { entityType: 'access_grant', entityId: { in: grantIds } },
          ],
        },
      });
      // Reset every sync + cache column; KEEP folder pointer + business fields.
      await tx.account.update({
        where: { id: account.id },
        data: {
          statusMarkdown: null,
          statusSensitiveMarkdown: null,
          driveBootstrapCursor: null,
          driveBootstrapCompletedAt: null,
          driveLastSyncedAt: null,
          driveActivityPageToken: null,
          driveStructureClassification: Prisma.JsonNull,
          driveBootstrapFiles: Prisma.JsonNull,
          driveLastRunAt: null,
        },
      });
    },
    { timeout: 120_000 },
  );

  logger.info(
    { accountId: account.id, accountName: account.name, counts },
    '[clear-account] complete nuke applied',
  );

  return { accountId: account.id, accountName: account.name, apply: true, counts };
}
