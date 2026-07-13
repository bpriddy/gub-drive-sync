/** probe-deck-days.ts — list slide decks under a folder grouped by effective
 *  day (max(modifiedTime, createdTime) — same rule as groupFilesByDate), so a
 *  test scan can target a deck-heavy day.
 *    DATABASE_URL=… npx tsx -r dotenv/config scripts/probe-deck-days.ts <folderId>
 */
import { traverseFolder } from '../src/drive/traversal';

async function main(): Promise<void> {
  const folderId = process.argv[2];
  if (!folderId) throw new Error('pass a folder id');
  const byDay = new Map<string, string[]>();
  for await (const f of traverseFolder(folderId, 'probe', {})) {
    if (f.isFolder) continue;
    if (!f.mimeType.includes('presentation')) continue;
    const eff = [f.modifiedTime, f.createdTime].filter(Boolean).sort().pop();
    if (!eff) continue;
    const day = eff.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(f.name);
    byDay.set(day, arr);
  }
  for (const [day, names] of [...byDay.entries()].sort()) {
    console.log(`${day}  (${names.length})`);
    for (const n of names) console.log(`    ${n}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
