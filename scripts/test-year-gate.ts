/**
 * test-year-gate.ts — deterministic tests (no LLM, no DB) for:
 *   1. extractYearFromPath — structural year from the folder breadcrumb
 *   2. partitionClusterByYear — same-name clusters split by year
 *   3. overlayPieceAnchors + buildAttributor — piece folders route to their
 *      owning campaign (the anti-resplit overlay)
 *
 *   npx tsx scripts/test-year-gate.ts
 */
import { extractYearFromPath, partitionClusterByYear } from '../src/drive/campaign-merge';
import { buildAttributor, overlayPieceAnchors, type EntityMap } from '../src/drive/structure';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}\n       expected ${e}\n       got      ${a}`); }
}

// ── 1. extractYearFromPath ───────────────────────────────────────────────────
console.log('\nextractYearFromPath');
check('year folder in path', extractYearFromPath('Chevy / 02. Master Project Folder / 2026 / 13. Chevy | BHAC AI + LMA Tool [GMCHV550002340]'), 2026);
check('deepest year wins', extractYearFromPath('X / 2024 / archive / 2025 / Truck Season'), 2025);
check('year in TITLE does not count', extractYearFromPath('Chevy / Projects / 17. Chevy | Holiday 2026'), null);
check('no year anywhere', extractYearFromPath('Chevy / Brand Assets / Logos'), null);
check('null path', extractYearFromPath(null), null);
check('1990s year', extractYearFromPath('A / 1998 / Retro Campaign'), 1998);
check('5-digit number ignored', extractYearFromPath('A / 20261 / Foo'), null);

// ── 2. partitionClusterByYear ────────────────────────────────────────────────
console.log('\npartitionClusterByYear');
const cluster = {
  canonicalId: 'a',
  canonicalName: 'Truck Season',
  variantIds: ['b', 'c', 'd'],
  variantNames: ['TRUCK SEASON CAMPAIGN', 'Truck Season Retail', 'Truck Season (no folder)'],
  confidence: 0.9,
  reasoning: 'same campaign name',
};

// a=2025, b=2025, c=2024, d=unknown → sub-cluster {a,b}@2025; c singleton; d dropped
const p1 = partitionClusterByYear(cluster, new Map([['a', 2025], ['b', 2025], ['c', 2024], ['d', null]]));
check('same-year pair merges', p1.subClusters.map((s) => ({ c: s.canonicalId, v: s.variantIds, y: s.year })), [{ c: 'a', v: ['b'], y: 2025 }]);
check('different-year member is singleton', p1.droppedSingleton, ['c']);
check('unknown-year member dropped', p1.droppedUnknownYear, ['d']);

// all unknown → cluster dissolves entirely
const p2 = partitionClusterByYear(cluster, new Map([['a', null], ['b', null], ['c', null], ['d', null]]));
check('all-unknown dissolves', { subs: p2.subClusters.length, dropped: p2.droppedUnknownYear.length }, { subs: 0, dropped: 4 });

// canonical NOT in the surviving year group → sub-cluster re-picks canonical
const p3 = partitionClusterByYear(cluster, new Map([['a', 2024], ['b', 2025], ['c', 2025], ['d', 2025]]));
check('canonical re-picked when original lands elsewhere', p3.subClusters.map((s) => ({ c: s.canonicalId, v: s.variantIds.sort(), y: s.year })), [{ c: 'b', v: ['c', 'd'], y: 2025 }]);
check('original canonical becomes singleton', p3.droppedSingleton, ['a']);

// two viable year groups → two sub-clusters
const p4 = partitionClusterByYear(cluster, new Map([['a', 2025], ['b', 2025], ['c', 2024], ['d', 2024]]));
check('two year groups → two sub-clusters', p4.subClusters.map((s) => s.year).sort(), [2024, 2025]);

// ── 3. overlayPieceAnchors + buildAttributor (anti-resplit) ─────────────────
console.log('\noverlayPieceAnchors + buildAttributor');
// Real BHAC shape: 02 (canonical root) and 13 (merged variant, now a piece)
// are SIBLINGS under the year folder. A file lives in a subfolder of 13.
const map: EntityMap = {
  accountId: 'acct-1',
  accountName: 'Chevy',
  allFolders: [
    { id: 'f-master', name: '02. Master Project Folder', path: 'Chevy / 02. Master Project Folder', depth: 1, parentId: null },
    { id: 'f-2026', name: '2026', path: 'Chevy / 02. Master Project Folder / 2026', depth: 2, parentId: 'f-master' },
    { id: 'f-02', name: '02. Chevy | BHAC', path: 'Chevy / 02. Master Project Folder / 2026 / 02. Chevy | BHAC', depth: 3, parentId: 'f-2026' },
    { id: 'f-13', name: '13. Chevy | BHAC AI + LMA Tool', path: 'Chevy / 02. Master Project Folder / 2026 / 13. Chevy | BHAC AI + LMA Tool', depth: 3, parentId: 'f-2026' },
    { id: 'f-13-decks', name: 'Decks', path: 'Chevy / 02. Master Project Folder / 2026 / 13. Chevy | BHAC AI + LMA Tool / Decks', depth: 4, parentId: 'f-13' },
  ],
  classified: [
    { folderId: 'f-02', folderPath: '… / 02. Chevy | BHAC', classification: 'existing_campaign', campaignName: '02. Chevy | BHAC', matchedCampaignId: 'camp-bhac', reasoning: 'anchor' },
    // The LLM re-flags the merged variant's folder as a campaign — the bug.
    { folderId: 'f-13', folderPath: '… / 13. Chevy | BHAC AI + LMA Tool', classification: 'new_campaign', campaignName: 'BHAC AI + LMA Tool', matchedCampaignId: null, reasoning: 'looks like a campaign' },
  ],
  driver: 'test',
  folderCount: 5,
};

// WITHOUT overlay: file under 13/Decks attributes to a NEW campaign (re-split).
const before = buildAttributor(map)('f-13-decks');
check('without overlay: re-split (new campaign)', { owner: before.ownerType, status: before.campaignStatus }, { owner: 'campaign', status: 'new' });

// WITH overlay: folder 13 is a piece of camp-bhac → routes to the EXISTING campaign.
const anchors = [
  { driveFolderId: 'f-13', campaignId: 'camp-bhac', campaignName: '02. Chevy | BHAC', pieceId: 'piece-13', pieceName: '13. Chevy | BHAC AI + LMA Tool' },
];
const overlaid = overlayPieceAnchors(map, anchors);
const after = buildAttributor(overlaid, anchors)('f-13-decks');
check('with overlay: routes to owning campaign', { owner: after.ownerType, status: after.campaignStatus, id: after.matchedCampaignId }, { owner: 'campaign', status: 'existing', id: 'camp-bhac' });
check('attribution carries the PIECE identity', { pieceId: after.pieceId, pieceName: after.pieceName, folder: after.pieceFolderId }, { pieceId: 'piece-13', pieceName: '13. Chevy | BHAC AI + LMA Tool', folder: 'f-13' });

// A file under the campaign's OWN root gets campaign attribution, no piece.
const campaignRootFile = buildAttributor(overlaid, anchors)('f-02');
check('campaign-root file has NO piece identity', { id: campaignRootFile.matchedCampaignId, pieceId: campaignRootFile.pieceId }, { id: 'camp-bhac', pieceId: null });

// The LLM's stale new_campaign classification for f-13 is dropped.
check('LLM classification for piece folder dropped', overlaid.classified.filter((c) => c.folderId === 'f-13').map((c) => c.classification), ['existing_campaign']);

// A piece folder NOT in this tree injects nothing.
const foreign = overlayPieceAnchors(map, [{ driveFolderId: 'f-elsewhere', campaignId: 'x', campaignName: 'X', pieceId: 'p-x', pieceName: 'X piece' }]);
check('foreign piece folder ignored', foreign.classified.length, map.classified.length);

console.log(failures === 0 ? '\n🎯 ALL PASS' : `\n⚠ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
