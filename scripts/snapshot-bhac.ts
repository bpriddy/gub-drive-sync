/** snapshot-bhac.ts — full three-tier snapshot: campaign markdown, piece
 *  markdown, ideas + change history. Read-only. */
import { prisma } from '../src/prisma';

async function main(): Promise<void> {
  const campaigns = await prisma.campaign.findMany({
    where: { account: { name: { contains: 'chevy', mode: 'insensitive' } } },
    include: { pieces: true },
    orderBy: { name: 'asc' },
  });
  console.log(`\n════════ CAMPAIGNS (${campaigns.length}) ════════`);
  for (const c of campaigns) {
    console.log(`\n▸ ${c.name}`);
    console.log(`  status=${c.status}  liveAt=${c.liveAt?.toISOString().slice(0, 10) ?? '—'}  pieces=${c.pieces.length}`);
    if (c.statusMarkdown) {
      console.log('  ── campaign markdown ──');
      for (const l of c.statusMarkdown.split('\n')) console.log(`  │ ${l}`);
    } else console.log('  (no markdown)');
    for (const p of c.pieces) {
      console.log(`\n  ◆ PIECE: ${p.name}`);
      if (p.statusMarkdown) {
        console.log('    ── piece markdown ──');
        for (const l of p.statusMarkdown.split('\n')) console.log(`    │ ${l}`);
      } else console.log('    (no markdown yet)');
    }
  }

  const ideas = await prisma.idea.findMany({ include: { changes: { orderBy: { changedAt: 'asc' } } } });
  console.log(`\n════════ IDEAS (${ideas.length}) ════════`);
  for (const i of ideas) {
    console.log(`\n▸ ${i.name}  (${i.facets.length} facets, ${i.changes.length} change rows)`);
    for (const f of i.facets) console.log(`    - ${f}`);
    console.log(`  history: ${i.changes.map((ch) => (ch.previousValueText === null ? 'birth' : 'merge')).join(' → ')}`);
  }
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
