/**
 * clear.ts — reset Drive-sync data for an account or campaign, or wipe
 * every campaign in the DB.
 *
 * DEV/TEST UTILITY. Not for production. The backfill iteration loop is
 * the primary user — running scans, inspecting output, clearing, re-
 * running.
 *
 * Three modes (pass exactly one):
 *
 *   --account-id <uuid>
 *     COMPLETE per-account nuke for a clean re-bootstrap. The account row
 *     itself stays (folder pointer + business fields kept); everything else
 *     Drive-sync goes. Delegates to clearAccountComplete (src/drive/
 *     clear-account.ts) — the same code the `clear-account` Cloud Run mode
 *     runs — so it wipes ALL of: drive_change_proposals, drive_scan_logs,
 *     drive_file_snapshots, drive_sync_runs, campaign_changes, campaigns,
 *     account_changes, access_grants (account + campaign), audit_log; and
 *     resets every account sync/cache column incl. drive_bootstrap_cursor,
 *     drive_structure_classification, drive_bootstrap_files. See that module
 *     for the audit_log dev/prod strictness note.
 *
 *   --campaign-id <uuid>
 *     Clear sync state for a single campaign. The campaign row stays.
 *     Resets status_markdown + status_sensitive_markdown to NULL.
 *     Deletes campaign_changes, drive_change_proposals, drive_scan_logs
 *     for this campaign only.
 *
 *   --all-campaigns
 *     Nuclear option: delete every campaign in the DB, plus all sync
 *     state tied to any campaign. Accounts and account-level state are
 *     NOT touched.
 *
 * Confirmation: prompts for typed "DELETE" before proceeding. Use --yes
 * to skip (don't pipe untrusted input).
 *
 * Usage:
 *   npm run clear -- --campaign-id <uuid>
 *   npm run clear -- --account-id <uuid>
 *   npm run clear -- --all-campaigns
 *   npm run clear -- --all-campaigns --yes
 */
import * as readline from 'node:readline/promises';
import { prisma } from '../src/prisma';
import { clearAccountComplete } from '../src/drive/clear-account';

interface Args {
  accountId?: string;
  campaignId?: string;
  allCampaigns: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const accountId = get('--account-id');
  const campaignId = get('--campaign-id');
  const allCampaigns = has('--all-campaigns');

  const modeCount = [!!accountId, !!campaignId, allCampaigns].filter(Boolean).length;
  if (modeCount === 0) {
    throw new Error(
      'Pass exactly one of --account-id <uuid>, --campaign-id <uuid>, or --all-campaigns',
    );
  }
  if (modeCount > 1) {
    throw new Error('Pass exactly one of --account-id, --campaign-id, --all-campaigns');
  }

  const out: Args = {
    allCampaigns,
    yes: has('--yes'),
  };
  if (accountId) out.accountId = accountId;
  if (campaignId) out.campaignId = campaignId;
  return out;
}

async function confirmDelete(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type DELETE to confirm (anything else cancels): ');
  rl.close();
  return answer.trim() === 'DELETE';
}

// ── Campaign single-clear ──────────────────────────────────────────────────

async function clearCampaign(campaignId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.driveChangeProposal.deleteMany({ where: { campaignId } });
    await tx.driveScanLog.deleteMany({ where: { campaignId } });
    await tx.campaignChange.deleteMany({ where: { campaignId } });
    await tx.campaign.update({
      where: { id: campaignId },
      data: { statusMarkdown: null, statusSensitiveMarkdown: null },
    });
  });
}

// ── Account clear (COMPLETE nuke — deletes child campaigns) ─────────────────
//
// Delegates to the shared clearAccountComplete so the local script and the
// `clear-account` Cloud Run mode do the identical, gap-free wipe (bootstrap
// cache columns, drive_file_snapshots, drive_sync_runs, access_grants,
// audit_log — none of which the old inline version handled). See
// src/drive/clear-account.ts.

async function clearAccount(accountId: string): Promise<{ childCount: number }> {
  const result = await clearAccountComplete({ accountId, apply: true });
  return { childCount: result.counts.campaigns };
}

// ── All-campaigns nuclear ──────────────────────────────────────────────────

async function deleteAllCampaigns(): Promise<{
  campaigns: number;
  proposals: number;
  scanLogs: number;
  campaignChanges: number;
}> {
  // FK-safe order. The campaign_changes ↔ campaigns FK is NOT
  // cascade-on-delete in this schema, so we delete campaign_changes
  // explicitly before the campaigns themselves.
  const proposals = await prisma.driveChangeProposal.deleteMany({
    where: { campaignId: { not: null } },
  });
  const scanLogs = await prisma.driveScanLog.deleteMany({
    where: { campaignId: { not: null } },
  });
  const campaignChanges = await prisma.campaignChange.deleteMany();
  const campaigns = await prisma.campaign.deleteMany();
  return {
    campaigns: campaigns.count,
    proposals: proposals.count,
    scanLogs: scanLogs.count,
    campaignChanges: campaignChanges.count,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.accountId) {
    const account = await prisma.account.findUnique({
      where: { id: args.accountId },
      select: { id: true, name: true },
    });
    if (!account) throw new Error(`No account with id ${args.accountId}`);

    const [childCount, acctProposalCount, campaignProposalCount, acctChangeCount, acctScanLogCount] =
      await Promise.all([
        prisma.campaign.count({ where: { accountId: args.accountId } }),
        prisma.driveChangeProposal.count({
          where: { accountId: args.accountId, campaignId: null },
        }),
        prisma.driveChangeProposal.count({
          where: { campaign: { accountId: args.accountId } },
        }),
        prisma.accountChange.count({ where: { accountId: args.accountId } }),
        prisma.driveScanLog.count({ where: { accountId: args.accountId } }),
      ]);

    console.log(`Account: ${account.name}  (${account.id})`);
    console.log(`  Child campaigns to delete:           ${childCount}`);
    console.log(`  Account audit rows to delete:        ${acctChangeCount}`);
    console.log(`  Drive proposals (account-level):     ${acctProposalCount}`);
    console.log(`  Drive proposals (under campaigns):   ${campaignProposalCount}`);
    console.log(`  Drive scan logs (account-tied):      ${acctScanLogCount}`);
    console.log(`  Reset status_markdown + status_sensitive_markdown → NULL.`);
    console.log(`  Reset drive_backfill_cursor → NULL.`);
    console.log('');

    if (!args.yes && !(await confirmDelete())) {
      console.log('Cancelled.');
      return;
    }

    const result = await clearAccount(args.accountId);
    console.log(`✓ Account cleared. ${result.childCount} child campaign(s) deleted.`);
    return;
  }

  if (args.campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: args.campaignId },
      select: { id: true, name: true, account: { select: { name: true } } },
    });
    if (!campaign) throw new Error(`No campaign with id ${args.campaignId}`);

    const [proposalCount, scanLogCount, changeCount] = await Promise.all([
      prisma.driveChangeProposal.count({ where: { campaignId: args.campaignId } }),
      prisma.driveScanLog.count({ where: { campaignId: args.campaignId } }),
      prisma.campaignChange.count({ where: { campaignId: args.campaignId } }),
    ]);

    console.log(`Campaign: ${campaign.name}  (${campaign.id})  under ${campaign.account.name}`);
    console.log(`  Audit rows to delete:        ${changeCount}`);
    console.log(`  Drive proposals to delete:   ${proposalCount}`);
    console.log(`  Drive scan logs to delete:   ${scanLogCount}`);
    console.log(`  Reset status_markdown + status_sensitive_markdown → NULL.`);
    console.log(`  Campaign row will NOT be deleted.`);
    console.log('');

    if (!args.yes && !(await confirmDelete())) {
      console.log('Cancelled.');
      return;
    }

    await clearCampaign(args.campaignId);
    console.log('✓ Campaign sync data cleared.');
    return;
  }

  if (args.allCampaigns) {
    const [campaignCount, proposalCount, scanLogCount, campaignChangeCount] =
      await Promise.all([
        prisma.campaign.count(),
        prisma.driveChangeProposal.count({ where: { campaignId: { not: null } } }),
        prisma.driveScanLog.count({ where: { campaignId: { not: null } } }),
        prisma.campaignChange.count(),
      ]);

    console.log('⚠ NUCLEAR: delete EVERY campaign in the DB.');
    console.log(`  Campaigns to delete:           ${campaignCount}`);
    console.log(`  Campaign_changes to delete:    ${campaignChangeCount}`);
    console.log(`  Drive proposals to delete:     ${proposalCount}  (campaign-tied)`);
    console.log(`  Drive scan logs to delete:     ${scanLogCount}    (campaign-tied)`);
    console.log(`  Accounts and account-level state are NOT touched.`);
    console.log('');

    if (!args.yes && !(await confirmDelete())) {
      console.log('Cancelled.');
      return;
    }

    const result = await deleteAllCampaigns();
    console.log(
      `✓ Deleted ${result.campaigns} campaign(s), ${result.campaignChanges} change row(s), ${result.proposals} proposal(s), ${result.scanLogs} scan log(s).`,
    );
    return;
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
