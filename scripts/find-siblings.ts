/** find-siblings.ts — list the real sibling folders of a given folder (its
 *  parent's subfolders). Read-only. DATABASE_URL=…proxy… (bot token in DB). */
import { driveClient } from '../src/drive/client';

async function main(): Promise<void> {
  const folderId = process.argv[2];
  if (!folderId) throw new Error('pass a folder id');
  const drive = await driveClient();
  const meta = await drive.files.get({ fileId: folderId, fields: 'id,name,parents', supportsAllDrives: true });
  const parent = meta.data.parents?.[0];
  console.log(`target: ${meta.data.name}\nparent: ${parent}\n--- siblings ---`);
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      corpora: 'drive',
      driveId: '0AOr-kVmmASVYUk9PVA',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'nextPageToken, files(id,name)',
      pageSize: 200,
      orderBy: 'name',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of res.data.files ?? []) console.log(`  ${f.name}`);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
