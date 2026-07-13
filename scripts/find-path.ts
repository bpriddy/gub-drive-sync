/** find-path.ts — walk a folder's ancestry up to the drive root, printing the
 *  breadcrumb. Read-only. DATABASE_URL=…proxy… (bot token in DB). */
import { driveClient } from '../src/drive/client';

async function main(): Promise<void> {
  const drive = await driveClient();
  let id: string | undefined = process.argv[2];
  const chain: string[] = [];
  const DRIVE_ROOT = '0AOr-kVmmASVYUk9PVA';
  for (let i = 0; id && i < 20; i++) {
    if (id === DRIVE_ROOT) { chain.unshift('[SHARED DRIVE ROOT]'); break; }
    const meta = await drive.files.get({ fileId: id, fields: 'id,name,parents', supportsAllDrives: true });
    chain.unshift(`${meta.data.name}`);
    id = meta.data.parents?.[0];
  }
  console.log(chain.join('\n  ↳ '));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
