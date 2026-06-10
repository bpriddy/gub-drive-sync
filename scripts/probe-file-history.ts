/**
 * probe-file-history.ts — Side-by-side comparison of two Drive APIs
 * for the SAME file.
 *
 * Picks the N oldest files in an account's shared drive, then for each
 * one calls:
 *   1. revisions.list  (Drive v3) — shows the file's full revision history
 *   2. activity.query  (Drive Activity API) — shows events on this item
 *
 * For each file we print, side-by-side:
 *   - createdTime / modifiedTime (from the file metadata)
 *   - earliest + latest revision time (from revisions.list)
 *   - earliest + latest activity time (from activity.query)
 *   - whether the activity API saw events back to the file's creation
 *
 * The question we're answering: does the Activity API have a tighter
 * retention/visibility window than the revisions API for the same file
 * accessed by the same bot user? If revisions.list shows revisions from
 * 2021 but activity.query stops at 2024 for the SAME fileId, that's
 * conclusive evidence the Activity API is the bottleneck.
 *
 * Usage:
 *   npm run probe-file-history -- --account-id <uuid>  [--count 5]
 *
 *   --count N    Number of oldest files to probe (default 5)
 *   --account-id Account UUID — its drive_folder_id is the shared drive root
 *   --root       Alternative: pass the shared drive root folder ID directly
 */

import { google } from 'googleapis';
import { prisma } from '../src/prisma';
import { buildBotOAuthClient } from '../src/workspace';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const ACTIVITY_SCOPE = 'https://www.googleapis.com/auth/drive.activity.readonly';

interface Args {
  accountId?: string;
  rootFolderId?: string;
  count: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const countStr = get('--count');
  const out: Args = { count: countStr ? Number(countStr) : 5 };
  const a = get('--account-id');
  const r = get('--root');
  if (a) out.accountId = a;
  if (r) out.rootFolderId = r;
  return out;
}

interface OldestFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
}

async function findOldestFiles(
  drive: ReturnType<typeof google.drive>,
  driveId: string,
  count: number,
): Promise<OldestFile[]> {
  const out: OldestFile[] = [];
  // Page through ascending createdTime until we have N non-folder files.
  // The shared drive may have folders first or interspersed; we just
  // skip them.
  let pageToken: string | undefined;
  while (out.length < count) {
    const res = await drive.files.list({
      corpora: 'drive',
      driveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'createdTime',
      pageSize: 100,
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime)',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.createdTime) continue;
      if (f.mimeType === 'application/vnd.google-apps.folder') continue;
      out.push({
        id: f.id,
        name: f.name ?? '(no name)',
        mimeType: f.mimeType ?? '(no mime)',
        createdTime: f.createdTime,
        modifiedTime: f.modifiedTime ?? f.createdTime,
      });
      if (out.length >= count) break;
    }
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return out;
}

interface RevisionsResult {
  count: number;
  earliest: string | null;
  latest: string | null;
  errorMessage: string | null;
}

async function probeRevisions(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
): Promise<RevisionsResult> {
  const result: RevisionsResult = {
    count: 0,
    earliest: null,
    latest: null,
    errorMessage: null,
  };
  try {
    let pageToken: string | undefined;
    const times: string[] = [];
    do {
      const res = await drive.revisions.list({
        fileId,
        pageSize: 1000,
        fields: 'nextPageToken, revisions(id, modifiedTime)',
        ...(pageToken ? { pageToken } : {}),
      });
      for (const r of res.data.revisions ?? []) {
        if (r.modifiedTime) times.push(r.modifiedTime);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    times.sort();
    result.count = times.length;
    result.earliest = times[0] ?? null;
    result.latest = times[times.length - 1] ?? null;
  } catch (err) {
    result.errorMessage = err instanceof Error ? err.message : String(err);
  }
  return result;
}

interface ActivityResult {
  count: number;
  earliest: string | null;
  latest: string | null;
  errorMessage: string | null;
}

async function probeActivity(
  driveactivity: ReturnType<typeof google.driveactivity>,
  fileId: string,
): Promise<ActivityResult> {
  const result: ActivityResult = {
    count: 0,
    earliest: null,
    latest: null,
    errorMessage: null,
  };
  try {
    let pageToken: string | undefined;
    const times: string[] = [];
    let pages = 0;
    do {
      const res = await driveactivity.activity.query({
        requestBody: {
          itemName: `items/${fileId}`,
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      const activities = (res.data.activities ?? []) as Array<{
        timestamp?: string;
        timeRange?: { startTime?: string; endTime?: string };
      }>;
      for (const a of activities) {
        const t = a.timestamp ?? a.timeRange?.startTime ?? null;
        if (t) times.push(t);
      }
      pageToken = res.data.nextPageToken ?? undefined;
      pages += 1;
      if (pages >= 50) {
        // Safety: don't paginate forever during a probe.
        console.warn(`  ⚠ activity probe stopped at 50 pages (safety)`);
        break;
      }
    } while (pageToken);
    times.sort();
    result.count = times.length;
    result.earliest = times[0] ?? null;
    result.latest = times[times.length - 1] ?? null;
  } catch (err) {
    result.errorMessage = err instanceof Error ? err.message : String(err);
  }
  return result;
}

function yearsBetween(iso1: string, iso2: string): number {
  const a = new Date(iso1).getTime();
  const b = new Date(iso2).getTime();
  return (Math.abs(a - b) / (1000 * 60 * 60 * 24 * 365.25));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let rootFolderId = args.rootFolderId;
  if (!rootFolderId) {
    if (!args.accountId) {
      throw new Error('Pass --account-id <uuid> (or --root <folderId>)');
    }
    const acct = await prisma.account.findUnique({
      where: { id: args.accountId },
      select: { id: true, name: true, driveFolderId: true },
    });
    if (!acct) throw new Error(`No account with id ${args.accountId}`);
    if (!acct.driveFolderId) {
      throw new Error(`Account "${acct.name}" has no drive_folder_id`);
    }
    rootFolderId = acct.driveFolderId;
    console.log(`Account: ${acct.name}  (${acct.id})`);
  }
  console.log(`Drive root: ${rootFolderId}`);
  console.log(`Sampling ${args.count} oldest non-folder files`);
  console.log('');

  // Build clients. The activity scope is the only "new" one; without
  // it the probe fails at this line — that's the re-consent signal.
  const driveAuth = await buildBotOAuthClient('drive', [DRIVE_SCOPE]);
  const activityAuth = await buildBotOAuthClient('drive', [ACTIVITY_SCOPE]);
  const drive = google.drive({ version: 'v3', auth: driveAuth });
  const driveactivity = google.driveactivity({ version: 'v2', auth: activityAuth });
  console.log('  ✓ authenticated (drive + driveactivity)');
  console.log('');

  console.log('Finding oldest files…');
  const oldest = await findOldestFiles(drive, rootFolderId, args.count);
  if (oldest.length === 0) {
    console.log('No files found in the drive.');
    return;
  }
  console.log(`Found ${oldest.length} files.`);
  console.log('');

  // ── Per-file probe ────────────────────────────────────────────────
  console.log('═══ Per-file API comparison ═════════════════════════════════════════════');
  for (let i = 0; i < oldest.length; i++) {
    const f = oldest[i]!;
    console.log('');
    console.log(`▸ File ${i + 1}/${oldest.length}: "${f.name}"`);
    console.log(`  fileId:        ${f.id}`);
    console.log(`  mime:          ${f.mimeType}`);
    console.log(`  createdTime:   ${f.createdTime}`);
    console.log(`  modifiedTime:  ${f.modifiedTime}`);

    const [revs, acts] = await Promise.all([
      probeRevisions(drive, f.id),
      probeActivity(driveactivity, f.id),
    ]);

    console.log('  revisions.list  →');
    if (revs.errorMessage) {
      console.log(`    ✗ ERROR: ${revs.errorMessage}`);
    } else {
      console.log(`    count: ${revs.count}`);
      console.log(`    earliest: ${revs.earliest ?? '(none)'}`);
      console.log(`    latest:   ${revs.latest ?? '(none)'}`);
    }

    console.log('  activity.query  →');
    if (acts.errorMessage) {
      console.log(`    ✗ ERROR: ${acts.errorMessage}`);
    } else {
      console.log(`    count: ${acts.count}`);
      console.log(`    earliest: ${acts.earliest ?? '(none)'}`);
      console.log(`    latest:   ${acts.latest ?? '(none)'}`);
    }

    // ── Verdict per file ─────────────────────────────────────────
    if (revs.errorMessage || acts.errorMessage) {
      console.log('  → unable to compare (see error above)');
      continue;
    }
    if (revs.count === 0 && acts.count === 0) {
      console.log('  → no history on either API (file untouched since creation? or both blind?)');
      continue;
    }
    const revsReachesCreation =
      revs.earliest !== null &&
      yearsBetween(revs.earliest, f.createdTime) < 1; // within 1 yr of createdTime
    const actsReachesCreation =
      acts.earliest !== null &&
      yearsBetween(acts.earliest, f.createdTime) < 1;
    console.log(
      `  → revisions sees back to creation: ${revsReachesCreation ? 'YES' : 'NO'}    ` +
      `activity sees back to creation: ${actsReachesCreation ? 'YES' : 'NO'}`,
    );
    if (revsReachesCreation && !actsReachesCreation && acts.count > 0) {
      const gapYrs = yearsBetween(acts.earliest!, f.createdTime).toFixed(1);
      console.log(`     ⚠ ACTIVITY API HORIZON: ~${gapYrs}y short of file's creation`);
    }
  }

  // Per-file lines above give the YES/NO comparison. If revisions reaches
  // creation but activity doesn't, the Activity API has a tighter horizon
  // for the SAME bot — confirming the revisions-walk approach is needed
  // for historical depth.
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
