/**
 * reset-account-bootstrap.ts — clear an account's Drive-bootstrap state back to
 * "never bootstrapped" (cursor / completed / last-run / caches → NULL). Does NOT
 * touch campaigns, ideas, or any content. Used to undo the account-scoped side
 * effects of a campaign-scoped backfill (which writes account bootstrap fields).
 *
 *   DATABASE_URL=…proxy… npx tsx -r dotenv/config scripts/reset-account-bootstrap.ts --account-name Chevy
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';

function argVal(flag: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const accountName = argVal('--account-name');
  const accountId = argVal('--account-id');
  const account = await prisma.account.findFirst({
    where: accountId ? { id: accountId } : { name: { contains: accountName!, mode: 'insensitive' } },
    select: { id: true, name: true, driveBootstrapCursor: true, driveBootstrapCompletedAt: true, driveLastRunAt: true },
  });
  if (!account) throw new Error('account not found');
  console.log(`Before: cursor=${account.driveBootstrapCursor?.toISOString().slice(0, 10) ?? 'null'} completed=${account.driveBootstrapCompletedAt ? 'set' : 'null'} lastRun=${account.driveLastRunAt ? 'set' : 'null'}`);

  await prisma.account.update({
    where: { id: account.id },
    data: {
      driveBootstrapCursor: null,
      driveBootstrapCompletedAt: null,
      driveLastRunAt: null,
      driveBootstrapFiles: Prisma.JsonNull,
      driveStructureClassification: Prisma.JsonNull,
    },
  });
  console.log(`✓ ${account.name} bootstrap state reset to NULL (campaigns/ideas untouched)`);

  const campaigns = await prisma.campaign.findMany({
    where: { accountId: account.id },
    select: { id: true, name: true, status: true, statusMarkdown: true, _count: { select: { changes: true } } },
  });
  console.log(`\nCampaigns for ${account.name}: ${campaigns.length}`);
  for (const c of campaigns) {
    console.log(`  • "${c.name}" (${c.id})  status=${c.status}  changes=${c._count.changes}  status_markdown=${c.statusMarkdown ? `${c.statusMarkdown.length} chars` : 'none'}`);
  }
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
