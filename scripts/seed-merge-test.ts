/**
 * seed-merge-test.ts — DEV seed for the A+B acceptance test. Creates:
 *   - the REAL BHAC pair (real Drive folder ids + paths, both under 2026)
 *     → the merge SHOULD collapse these into 1 campaign + 1 piece.
 *   - a Truck Season control pair with paths under DIFFERENT years
 *     → the year gate must BLOCK this merge even if the detector clusters them.
 *
 * Folder 02's real id is looked up live from Drive (child of the 2026 folder).
 *
 *   DATABASE_URL=…proxy… npx tsx -r dotenv/config scripts/seed-merge-test.ts
 */
import { prisma } from '../src/prisma';
import { driveClient } from '../src/drive/client';
import { DRIVE_SYNC_SYSTEM_STAFF_ID } from '../src/drive/heal';

const YEAR_2026_FOLDER = '1OWOTN-ZalVCj1lwihpui9qwPnpApbdX8'; // "2026" under Master Project Folder
const BHAC_13_FOLDER = '1QIrTfKbls80_WJ5cDbsqNsidtlRQYNsl';
const PATH_PREFIX = 'Chevy / 02. Master Project Folder / 2026';

async function main(): Promise<void> {
  const account = await prisma.account.findFirst({
    where: { name: { contains: 'chevy', mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!account) throw new Error('Chevy account not found');

  // Live lookup: folder 02's real id (child of the 2026 folder named "02. Chevy | BHAC …").
  const drive = await driveClient();
  const res = await drive.files.list({
    q: `'${YEAR_2026_FOLDER}' in parents and mimeType = 'application/vnd.google-apps.folder' and name contains 'BHAC' and trashed = false`,
    corpora: 'drive',
    driveId: '0AOr-kVmmASVYUk9PVA',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: 'files(id,name)',
  });
  const bhac02 = (res.data.files ?? []).find((f) => f.name?.startsWith('02.'));
  if (!bhac02?.id || !bhac02.name) throw new Error('folder "02. Chevy | BHAC" not found under 2026');
  console.log(`resolved folder 02: ${bhac02.name} [${bhac02.id}]`);

  const rows = [
    // Real BHAC pair — same year (2026) → should merge into 1 campaign + 1 piece.
    { name: bhac02.name, driveFolderId: bhac02.id, driveFolderPath: `${PATH_PREFIX} / ${bhac02.name}` },
    {
      name: '13. Chevy | BHAC AI + LMA Tool [GMCHV550002340]',
      driveFolderId: BHAC_13_FOLDER,
      driveFolderPath: `${PATH_PREFIX} / 13. Chevy | BHAC AI + LMA Tool [GMCHV550002340]`,
    },
    // Year-control pair — same name meaning, DIFFERENT years → must NOT merge.
    {
      name: 'Truck Season 2025',
      driveFolderId: 'fake-folder-truck-2025',
      driveFolderPath: 'Chevy / 02. Master Project Folder / 2025 / Truck Season 2025',
    },
    {
      name: 'TRUCK SEASON CAMPAIGN',
      driveFolderId: 'fake-folder-truck-2024',
      driveFolderPath: 'Chevy / 02. Master Project Folder / 2024 / TRUCK SEASON CAMPAIGN',
    },
  ];

  for (const r of rows) {
    const existing = await prisma.campaign.findFirst({ where: { driveFolderId: r.driveFolderId }, select: { id: true } });
    if (existing) {
      console.log(`↺ exists: ${r.name}`);
      continue;
    }
    const c = await prisma.campaign.create({
      data: { ...r, accountId: account.id, createdBy: DRIVE_SYNC_SYSTEM_STAFF_ID },
      select: { id: true, name: true },
    });
    console.log(`＋ ${c.name}  (${c.id})`);
  }

  const count = await prisma.campaign.count({ where: { accountId: account.id } });
  console.log(`\nChevy campaigns now: ${count}`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
