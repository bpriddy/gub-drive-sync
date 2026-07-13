/** stock.ts — one-shot DB state snapshot (local, read-only). */
import { prisma } from '../src/prisma';

async function main(): Promise<void> {
  const chevy = await prisma.account.findFirst({
    where: { name: { contains: 'chevy', mode: 'insensitive' } },
    select: { id: true, name: true, driveFolderId: true },
  });

  const [accounts, campaigns, ideas, ideaChanges, pieces, botCreds] = await Promise.all([
    prisma.account.count(),
    prisma.campaign.count(),
    prisma.idea.count(),
    prisma.ideaChange.count(),
    prisma.campaignPiece.count(),
    prisma.botCredential.findMany({ select: { botName: true, scopes: true } }),
  ]);

  console.log('\n=== GLOBAL COUNTS ===');
  console.log({ accounts, campaigns, ideas, ideaChanges, pieces });
  console.log('bot_credentials:', botCreds.map((b) => `${b.botName}[${b.scopes.length} scopes]`).join(', ') || '(none)');

  if (chevy) {
    const [chevyCampaigns, chevyIdeas] = await Promise.all([
      prisma.campaign.count({ where: { accountId: chevy.id } }),
      prisma.idea.count({ where: { accountExternalId: chevy.driveFolderId ?? '__none__' } }),
    ]);
    console.log('\n=== CHEVY ===');
    console.log({ id: chevy.id, name: chevy.name, driveFolderId: chevy.driveFolderId, campaigns: chevyCampaigns, ideas: chevyIdeas });
    if (chevyIdeas > 0) {
      const sample = await prisma.idea.findMany({
        where: { accountExternalId: chevy.driveFolderId ?? '__none__' },
        select: { name: true, campaignExternalId: true, facets: true, _count: { select: { changes: true } } },
        take: 10,
      });
      console.log('idea rows:');
      for (const i of sample) console.log(`  • ${i.name}  (facets: ${i.facets.length}, changes: ${i._count.changes}, campaignExtId: ${i.campaignExternalId ?? '—'})`);
    }
  } else {
    console.log('\n(no Chevy account found)');
  }
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
