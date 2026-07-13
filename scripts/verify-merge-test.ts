/** verify-merge-test.ts — post-merge state check for the A+B acceptance test. */
import { prisma } from '../src/prisma';

async function main(): Promise<void> {
  const campaigns = await prisma.campaign.findMany({
    where: { account: { name: { contains: 'chevy', mode: 'insensitive' } } },
    select: { id: true, name: true, driveFolderPath: true, statusMarkdown: true, _count: { select: { pieces: true } } },
    orderBy: { name: 'asc' },
  });
  console.log(`\n=== CAMPAIGNS (${campaigns.length}) ===`);
  for (const c of campaigns) {
    console.log(`  • ${c.name}`);
    console.log(`      path: ${c.driveFolderPath ?? '—'}`);
    console.log(`      pieces: ${c._count.pieces}   markdown: ${c.statusMarkdown ? `${c.statusMarkdown.length} chars` : '—'}`);
  }

  const pieces = await prisma.campaignPiece.findMany({
    select: { id: true, name: true, driveFolderId: true, driveFolderPath: true, campaign: { select: { name: true } } },
  });
  console.log(`\n=== PIECES (${pieces.length}) ===`);
  for (const p of pieces) {
    console.log(`  • "${p.name}"  → piece of "${p.campaign.name}"`);
    console.log(`      folder: ${p.driveFolderId}   path: ${p.driveFolderPath ?? '—'}`);
  }

  const acct = await prisma.account.findFirst({
    where: { name: { contains: 'chevy', mode: 'insensitive' } },
    select: { driveStructureClassification: true },
  });
  console.log(`\nstructure cache: ${acct?.driveStructureClassification === null ? 'INVALIDATED (null) ✓' : 'still set ✗'}`);

  const audits = await prisma.auditLog.findMany({
    where: { action: 'campaign_merged' },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { after: true },
  });
  console.log(
    `audit rows (campaign_merged): ${audits.length}${audits[0] ? '  latest.after=' + JSON.stringify(audits[0].after).slice(0, 200) : ''}`,
  );
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
