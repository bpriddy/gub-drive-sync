/**
 * probe-permission-test.ts — Definitive permission-vs-API test.
 *
 * Background:
 *   Probing the Chevy drive showed revisions.list returns 0 for actively-
 *   edited Google-native files. Two hypotheses:
 *
 *     (P) Permissions: the bot has Viewer/Commenter role on those files,
 *         which Google blocks from seeing version history.
 *     (A) API: even with Editor role, Drive v3 revisions.list doesn't
 *         expose Google-native revision history without keepForever.
 *
 *   This script tests one specific file the operator created in a drive
 *   the bot has Editor (or higher) role on. If revisions.list returns
 *   non-zero, hypothesis P is confirmed and the path forward is to
 *   elevate the bot's role on the production drives. If revisions.list
 *   still returns 0, hypothesis A is confirmed and the data is genuinely
 *   not exposed via API at any role level.
 *
 * Setup required by the operator before running:
 *   1. Share the test shared drive with the bot user's email (the email
 *      tied to the 'drive' bot's refresh token) with role = Editor or
 *      Content Manager.
 *   2. Create a Google Doc in that drive and make a few edits over a
 *      span of time.
 *   3. Copy the doc's file ID from its URL.
 *
 * Usage:
 *   npm run probe-permission-test -- --file-id <fileId>
 */

import { google } from 'googleapis';
import { prisma } from '../src/prisma';
import { buildBotOAuthClient } from '../src/workspace';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const ACTIVITY_SCOPE = 'https://www.googleapis.com/auth/drive.activity.readonly';

interface Args {
  fileId?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out: Args = {};
  const f = get('--file-id');
  if (f) out.fileId = f;
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fileId) {
    throw new Error('Pass --file-id <fileId>');
  }

  console.log(`Probe target fileId: ${args.fileId}`);
  console.log('');

  // Bot's email — useful to tell the operator who they need to share the
  // drive with.
  const botRow = await prisma.botCredential.findUnique({
    where: { botName: 'drive' },
    select: { googleEmail: true, scopes: true },
  });
  if (botRow) {
    console.log(`Bot 'drive' identity:`);
    console.log(`  email:  ${botRow.googleEmail}`);
    console.log(`  scopes: ${botRow.scopes.join(', ')}`);
    console.log(`  → make sure this email has Editor/Content Manager role on the test drive`);
    console.log('');
  }

  const driveAuth = await buildBotOAuthClient('drive', [DRIVE_SCOPE]);
  const activityAuth = await buildBotOAuthClient('drive', [ACTIVITY_SCOPE]);
  const drive = google.drive({ version: 'v3', auth: driveAuth });
  const driveactivity = google.driveactivity({ version: 'v2', auth: activityAuth });
  console.log('  ✓ authenticated');
  console.log('');

  // 1. File metadata + bot's effective role
  console.log('═══ File metadata ═══════════════════════════════════════════════════');
  try {
    const meta = await drive.files.get({
      fileId: args.fileId,
      fields: 'id, name, mimeType, createdTime, modifiedTime, capabilities(canEdit, canReadRevisions, canModifyContent), permissions(role, emailAddress)',
      supportsAllDrives: true,
    });
    console.log(`  name:          ${meta.data.name}`);
    console.log(`  mime:          ${meta.data.mimeType}`);
    console.log(`  createdTime:   ${meta.data.createdTime}`);
    console.log(`  modifiedTime:  ${meta.data.modifiedTime}`);
    console.log('  Bot capabilities on this file:');
    const caps = meta.data.capabilities ?? {};
    console.log(`    canEdit:           ${caps.canEdit ?? '(unset)'}`);
    console.log(`    canReadRevisions:  ${caps.canReadRevisions ?? '(unset)'}`);
    console.log(`    canModifyContent:  ${caps.canModifyContent ?? '(unset)'}`);
  } catch (err) {
    console.log(`  ✗ files.get FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.log('');
    console.log('  → If this is a 404, the bot does not have access to the file.');
    console.log('    Share the drive with the bot email shown above and retry.');
    return;
  }
  console.log('');

  // 2. revisions.list — the key question
  console.log('═══ revisions.list (the decisive call) ═══════════════════════════════');
  try {
    let pageToken: string | undefined;
    const rows: unknown[] = [];
    do {
      const res = await drive.revisions.list({
        fileId: args.fileId,
        pageSize: 200,
        fields:
          'nextPageToken, revisions(id, modifiedTime, lastModifyingUser(emailAddress,displayName), size, keepForever, mimeType, publishAuto, published)',
        ...(pageToken ? { pageToken } : {}),
      });
      for (const r of res.data.revisions ?? []) rows.push(r);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    console.log(`  total revisions: ${rows.length}`);
    if (rows.length > 0) {
      console.log(`  ✓ NON-ZERO RESULT — hypothesis P (permissions) is confirmed.`);
      console.log(`    Elevating bot role on production drives would unlock revisions.`);
      console.log('');
      console.log(`  First ${Math.min(5, rows.length)} revision rows (raw JSON):`);
      for (const row of rows.slice(0, 5)) {
        console.log(`    ${JSON.stringify(row)}`);
      }
    } else {
      console.log(`  ✗ ZERO RESULT — hypothesis A (API limitation) is confirmed.`);
      console.log(`    Even with Editor role, revisions.list does not expose Google-native`);
      console.log(`    revision history. Historical content is unreachable via this API.`);
    }
  } catch (err) {
    console.log(`  ✗ revisions.list FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log('');

  // 3. activity.query for the same file — sanity check
  console.log('═══ activity.query (sanity — what events are visible?) ══════════════');
  try {
    let pageToken: string | undefined;
    const events: unknown[] = [];
    let pages = 0;
    do {
      const res = await driveactivity.activity.query({
        requestBody: {
          itemName: `items/${args.fileId}`,
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      for (const a of res.data.activities ?? []) events.push(a);
      pageToken = res.data.nextPageToken ?? undefined;
      pages += 1;
      if (pages >= 20) break;
    } while (pageToken);
    console.log(`  total events: ${events.length}`);
    if (events.length > 0) {
      console.log(`  First event (raw JSON, looking for new fields):`);
      console.log(`    ${JSON.stringify(events[0], null, 2).split('\n').join('\n    ')}`);
    }
  } catch (err) {
    console.log(`  ✗ activity.query FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log('');

  console.log('═══ Verdict ════════════════════════════════════════════════════════');
  console.log('  Look at the revisions.list count above:');
  console.log('    > 0 ⇒ bot needs Editor+ on production drives to unlock revisions');
  console.log('    = 0 ⇒ Google does not expose Google-native revisions via this API');
  console.log('         at any role; historical content backfill is impossible');
  console.log('');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('');
    console.error('FAILED:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
