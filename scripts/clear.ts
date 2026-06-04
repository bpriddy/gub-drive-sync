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
 *     Clear all Drive-sync state for an account AND every child campaign.
 *     The account row itself stays. Child campaign ROWS are deleted (you
 *     re-discover them on the next structure-aware backfill scan).
 *     Specifically deletes:
 *       - drive_change_proposals tied to the account or any child campaign
 *       - drive_scan_logs tied to the account or any child campaign
 *       - account_changes for this account
 *       - campaign_changes for each child campaign (cascade with delete)
 *       - all child campaigns
 *     And resets to NULL:
 *       - accounts.status_markdown + accounts.status_sensitive_markdown
 *       - accounts.drive_backfill_cursor (so the next backfill restarts
 *         from the earliest active day)
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

// ── Account clear (deletes child campaigns) ────────────────────────────────

async function clearAccount(accountId: string): Promise<{ childCount: number }> {
  const childCampaigns = await prisma.campaign.findMany({
    where: { accountId },
    select: { id: true },
  });

  await prisma.$transaction(async (tx) => {
    for (const c of childCampaigns) {
      await tx.driveChangeProposal.deleteMany({ where: { campaignId: c.id } });
      await tx.driveScanLog.deleteMany({ where: { campaignId: c.id } });
      // campaign_changes ↔ campaigns FK is NOT cascade-on-delete in this
      // schema; explicit delete required before the campaign row goes.
      await tx.campaignChange.deleteMany({ where: { campaignId: c.id } });
      await tx.campaign.delete({ where: { id: c.id } });
    }
    // Account-level cleanup.
    await tx.driveChangeProposal.deleteMany({ where: { accountId, campaignId: null } });
    await tx.driveScanLog.deleteMany({ where: { accountId, campaignId: null } });
    await tx.accountChange.deleteMany({ where: { accountId } });
    await tx.account.update({
      where: { id: accountId },
      data: {
        statusMarkdown: null,
        statusSensitiveMarkdown: null,
        driveBackfillCursor: null,
      },
    });
  });

  return { childCount: childCampaigns.length };
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
