/**
 * test-dedup.ts — BLIND test of the campaign-dedup prompt on the REAL Chevy
 * roster (the actual sibling folders of the BHAC project). No DB; runs the real
 * detectCampaignClusters. The model is NOT told the labels.
 *
 * Primary target: 02 (BHAC) + 13 (BHAC AI + LMA Tool) must MERGE.
 * Guard: no cluster may mix two different real campaigns (over-merge).
 *
 *   npx tsx -r dotenv/config scripts/test-dedup.ts     (needs GEMINI_API_KEY)
 */
import { detectCampaignClusters, type CampaignForClustering } from '../src/drive/campaign-cluster-detector';

// Real folder names → the true campaign each belongs to (for SCORING only).
// 'bhac' is the target merge. 'grounded'/'t1-1' are plausible secondary merges
// (reported, not required). Everything else is its own distinct campaign.
const ROSTER: Array<{ name: string; truth: string }> = [
  { name: '01. Chevy | See the USA [GMCHV55000198]', truth: 'usa' },
  { name: '02. Chevy | BHAC [GMCHV55000216]', truth: 'bhac' },
  { name: '03. Chevy | Racing [GMCHV55000215]', truth: 'racing' },
  { name: '04. Chevy | T1-2 [GMCHV55000242]', truth: 't1-2' },
  { name: '05. Chevy | Heartbeat of America [GMCHV55000220]', truth: 'heartbeat' },
  { name: '06. GM Defense | INTL Post Produced Edit [GMCHV55000212]', truth: 'gmdefense' },
  { name: '07. Chevy | Grounded Research waves 2 + 3', truth: 'grounded' },
  { name: '08. Chevy | Globalization', truth: 'globalization' },
  { name: '10. Chevy | T1-1 Selldown [GMCHV55000227]', truth: 't1-1' },
  { name: '11. CHEVY | GM ENTRANCE ONE HQ [GMCHV55000235]', truth: 'entrance' },
  { name: '12. Chevy | Q1 2027 SUV', truth: 'q1suv' },
  { name: '13. Chevy | BHAC AI + LMA Tool [GMCHV550002340]', truth: 'bhac' },
  { name: '14. T1-1 HD MCP [GMCHV55000238]', truth: 't1-1' },
  { name: '15. Chevy | Grounded Wave 2 [GMCHV55000204]', truth: 'grounded' },
  { name: '16. Chevy | Grounded Wave 3 [GMCHV55000222]', truth: 'grounded' },
  { name: '17. Chevy | Holiday 2026', truth: 'holiday' },
  { name: '18. Chevy | Red Tag 2026 [GMCHV55000249]', truth: 'redtag' },
];

async function main(): Promise<void> {
  const campaigns: CampaignForClustering[] = ROSTER.map((r, i) => ({
    id: `c${i + 1}`, name: r.name, status: 'pitch', driveFolderId: null, statusMarkdown: null, createdAt: new Date(),
  }));
  const truthOf = new Map(campaigns.map((c, i) => [c.id, ROSTER[i]!.truth]));
  const nameOf = new Map(campaigns.map((c) => [c.id, c.name]));

  const res = await detectCampaignClusters({ accountName: 'Chevy', campaigns });

  console.log(`\n=== ${res.clusters.length} cluster(s), ${res.droppedClusterCount} dropped ===\n`);
  let targetMerged = false;
  let overMerges = 0;
  for (const cl of res.clusters) {
    const ids = [cl.canonicalId, ...cl.variantIds];
    const truths = new Set(ids.map((id) => truthOf.get(id)));
    const clean = truths.size === 1;
    const label = clean ? (truths.has('bhac') ? '🎯 BHAC' : `✅ ${[...truths][0]}`) : '❌ OVER-MERGE';
    if (!clean) overMerges++;
    if (clean && truths.has('bhac') && ids.length >= 2) targetMerged = true;
    console.log(`${label}  [conf ${cl.confidence}]`);
    for (const id of ids) console.log(`     ${nameOf.get(id)}`);
    console.log(`     ↳ ${cl.reasoning}`);
  }

  console.log(`\n--- SCORE ---`);
  console.log(`TARGET  02+13 (BHAC) merged: ${targetMerged ? 'YES 🎯' : 'NO ❌'}`);
  console.log(`GUARD   over-merges (mixed distinct campaigns): ${overMerges}`);
  console.log(targetMerged && overMerges === 0 ? '\n✅ STABLE for this run' : '\n⚠ not there yet');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
