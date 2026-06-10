/**
 * probe-edited-files.ts — Examine the actively-edited files.
 *
 * Different from probe-file-history.ts: instead of sampling the OLDEST
 * files (which turned out to be untouched assets), this finds the
 * MOST-EDITED files by querying the Activity API for edit events
 * across the last N days, then picks the top fileIds by edit count.
 *
 * For each top file, we dump:
 *   1. file metadata (createdTime, modifiedTime, mimeType)
 *   2. revisions.list output with full fields — does this return any
 *      revisions for actively-edited Google-native files, or are they
 *      auto-purged without keepForever?
 *   3. First 3 activity events as RAW JSON — looking specifically for
 *      revisionId, content references, or any other field that would
 *      let us reach historical content
 *
 * Two yes/no questions this probe answers:
 *   Q1: Does revisions.list return non-zero revisions for actively-
 *       edited Google-native files?
 *   Q2: Do Activity API edit events carry enough metadata (e.g. a
 *       revisionId) to let us call revisions.get(fileId, revId)?
 *
 * Either Q being YES makes historical-content backfill viable. Both NO
 * means Google-native historical content is not recoverable via these
 * APIs.
 *
 * Usage:
 *   npm run probe-edited-files -- --account-id <uuid>  [--days 30] [--top 5]
 */

import { google } from 'googleapis';
import { prisma } from '../src/prisma';
import { buildBotOAuthClient } from '../src/workspace';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const ACTIVITY_SCOPE = 'https://www.googleapis.com/auth/drive.activity.readonly';

interface Args {
  accountId?: string;
  rootFolderId?: string;
  days: number;
  top: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out: Args = {
    days: Number(get('--days') ?? '30'),
    top: Number(get('--top') ?? '5'),
  };
  const a = get('--account-id');
  const r = get('--root');
  if (a) out.accountId = a;
  if (r) out.rootFolderId = r;
  return out;
}

interface EditCountEntry {
  fileId: string;
  editCount: number;
  totalCount: number;
  lastSeenTitle: string;
  lastSeenMime: string;
  earliestEditTime: string;
  latestEditTime: string;
}

interface RawActivity {
  timestamp?: string;
  timeRange?: { startTime?: string; endTime?: string };
  primaryActionDetail?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
  targets?: Array<{
    driveItem?: {
      name?: string;
      title?: string;
      mimeType?: string;
    };
  }>;
}

async function findMostEditedFiles(
  driveactivity: ReturnType<typeof google.driveactivity>,
  ancestorName: string,
  days: number,
  top: number,
): Promise<EditCountEntry[]> {
  const fromIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const toIso = new Date().toISOString();
  console.log(`Querying activity from ${fromIso.slice(0, 10)} to ${toIso.slice(0, 10)}…`);

  const counts = new Map<string, EditCountEntry>();
  let pageToken: string | undefined;
  let pages = 0;
  let totalActivities = 0;

  do {
    const res = await driveactivity.activity.query({
      requestBody: {
        ancestorName,
        filter: `time >= "${fromIso}" AND time < "${toIso}"`,
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    const activities = (res.data.activities ?? []) as RawActivity[];
    for (const a of activities) {
      totalActivities += 1;
      const t = a.targets?.[0]?.driveItem;
      if (!t?.name) continue;
      const fileId = t.name.replace(/^items\//, '');
      const title = t.title ?? '(no title)';
      const mime = t.mimeType ?? '(no mime)';
      const time = a.timestamp ?? a.timeRange?.startTime ?? '';
      const actionKey = Object.keys(a.primaryActionDetail ?? {})[0] ?? '';

      let entry = counts.get(fileId);
      if (!entry) {
        entry = {
          fileId,
          editCount: 0,
          totalCount: 0,
          lastSeenTitle: title,
          lastSeenMime: mime,
          earliestEditTime: '',
          latestEditTime: '',
        };
        counts.set(fileId, entry);
      }
      entry.totalCount += 1;
      entry.lastSeenTitle = title;
      entry.lastSeenMime = mime;
      if (actionKey === 'edit') {
        entry.editCount += 1;
        if (!entry.earliestEditTime || time < entry.earliestEditTime) entry.earliestEditTime = time;
        if (!entry.latestEditTime || time > entry.latestEditTime) entry.latestEditTime = time;
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
    pages += 1;
    if (pages >= 200) {
      console.warn(`  ⚠ stopping at 200 pages (safety)`);
      break;
    }
  } while (pageToken);

  console.log(`  Scanned ${totalActivities} activities across ${pages} pages, ${counts.size} unique files`);
  const ranked = Array.from(counts.values())
    .filter((e) => e.editCount > 0)
    .sort((a, b) => b.editCount - a.editCount)
    .slice(0, top);
  return ranked;
}

interface RevisionRow {
  id?: string | null;
  modifiedTime?: string | null;
  lastModifyingUser?: { emailAddress?: string | null; displayName?: string | null } | null;
  size?: string | null;
  keepForever?: boolean | null;
  mimeType?: string | null;
  publishAuto?: boolean | null;
  published?: boolean | null;
}

interface FullRevisions {
  count: number;
  earliestTime: string | null;
  latestTime: string | null;
  rows: RevisionRow[];
  errorMessage: string | null;
}

async function probeRevisionsFull(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
): Promise<FullRevisions> {
  const out: FullRevisions = {
    count: 0,
    earliestTime: null,
    latestTime: null,
    rows: [],
    errorMessage: null,
  };
  try {
    let pageToken: string | undefined;
    do {
      const res = await drive.revisions.list({
        fileId,
        pageSize: 200,
        // Ask for every field documented as available
        fields:
          'nextPageToken, revisions(id, modifiedTime, lastModifyingUser(emailAddress,displayName), size, keepForever, mimeType, publishAuto, published)',
        ...(pageToken ? { pageToken } : {}),
      });
      for (const r of res.data.revisions ?? []) {
        out.rows.push(r as RevisionRow);
        out.count += 1;
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    const times = out.rows
      .map((r) => r.modifiedTime)
      .filter((t): t is string => typeof t === 'string')
      .sort();
    out.earliestTime = times[0] ?? null;
    out.latestTime = times[times.length - 1] ?? null;
  } catch (err) {
    out.errorMessage = err instanceof Error ? err.message : String(err);
  }
  return out;
}

interface RawActivityDump {
  totalEvents: number;
  firstThreeRawJson: RawActivity[];
  errorMessage: string | null;
}

async function probeActivityRaw(
  driveactivity: ReturnType<typeof google.driveactivity>,
  fileId: string,
): Promise<RawActivityDump> {
  const out: RawActivityDump = {
    totalEvents: 0,
    firstThreeRawJson: [],
    errorMessage: null,
  };
  try {
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await driveactivity.activity.query({
        requestBody: {
          itemName: `items/${fileId}`,
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      const activities = (res.data.activities ?? []) as RawActivity[];
      for (const a of activities) {
        if (out.firstThreeRawJson.length < 3) out.firstThreeRawJson.push(a);
        out.totalEvents += 1;
      }
      pageToken = res.data.nextPageToken ?? undefined;
      pages += 1;
      if (pages >= 50) break;
    } while (pageToken);
  } catch (err) {
    out.errorMessage = err instanceof Error ? err.message : String(err);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let rootFolderId = args.rootFolderId;
  if (!rootFolderId) {
    if (!args.accountId) throw new Error('Pass --account-id <uuid> (or --root <folderId>)');
    const acct = await prisma.account.findUnique({
      where: { id: args.accountId },
      select: { id: true, name: true, driveFolderId: true },
    });
    if (!acct) throw new Error(`No account with id ${args.accountId}`);
    if (!acct.driveFolderId) throw new Error(`Account "${acct.name}" has no drive_folder_id`);
    rootFolderId = acct.driveFolderId;
    console.log(`Account: ${acct.name}  (${acct.id})`);
  }
  console.log(`Drive root: ${rootFolderId}`);
  console.log(`Days back: ${args.days}, top N: ${args.top}`);
  console.log('');

  const driveAuth = await buildBotOAuthClient('drive', [DRIVE_SCOPE]);
  const activityAuth = await buildBotOAuthClient('drive', [ACTIVITY_SCOPE]);
  const drive = google.drive({ version: 'v3', auth: driveAuth });
  const driveactivity = google.driveactivity({ version: 'v2', auth: activityAuth });
  console.log('  ✓ authenticated');
  console.log('');

  const ancestorName = `items/${rootFolderId}`;
  const ranked = await findMostEditedFiles(driveactivity, ancestorName, args.days, args.top);
  if (ranked.length === 0) {
    console.log('No edit activities found in the window. Try a wider --days range.');
    return;
  }
  console.log('');
  console.log(`Top ${ranked.length} most-edited files in the last ${args.days} days:`);
  for (const r of ranked) {
    console.log(`  ${r.editCount.toString().padStart(4)} edits  "${r.lastSeenTitle}"  [${r.lastSeenMime}]`);
  }
  console.log('');

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i]!;
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log(`▸ File ${i + 1}/${ranked.length}: "${r.lastSeenTitle}"`);
    console.log(`  fileId:        ${r.fileId}`);
    console.log(`  mime:          ${r.lastSeenMime}`);
    console.log(`  edits in window: ${r.editCount} (earliest ${r.earliestEditTime}, latest ${r.latestEditTime})`);

    // 1. File metadata
    let createdTime = '?';
    let modifiedTime = '?';
    try {
      const meta = await drive.files.get({
        fileId: r.fileId,
        fields: 'id, name, createdTime, modifiedTime, mimeType',
        supportsAllDrives: true,
      });
      createdTime = meta.data.createdTime ?? '?';
      modifiedTime = meta.data.modifiedTime ?? '?';
    } catch (err) {
      console.log(`  ⚠ files.get failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log(`  createdTime:   ${createdTime}`);
    console.log(`  modifiedTime:  ${modifiedTime}`);

    // 2. revisions.list (full)
    console.log('');
    console.log('  ── revisions.list (full fields) ──');
    const revs = await probeRevisionsFull(drive, r.fileId);
    if (revs.errorMessage) {
      console.log(`    ✗ ERROR: ${revs.errorMessage}`);
    } else {
      console.log(`    count: ${revs.count}`);
      console.log(`    earliest: ${revs.earliestTime ?? '(none)'}`);
      console.log(`    latest:   ${revs.latestTime ?? '(none)'}`);
      const keepCount = revs.rows.filter((r) => r.keepForever === true).length;
      console.log(`    keepForever revisions: ${keepCount} / ${revs.count}`);
      if (revs.rows.length > 0) {
        console.log(`    First 3 rows (raw JSON):`);
        for (const row of revs.rows.slice(0, 3)) {
          console.log(`      ${JSON.stringify(row)}`);
        }
      }
    }

    // 3. activity.query (raw events)
    console.log('');
    console.log('  ── activity.query (raw event dump for revisionId hunt) ──');
    const acts = await probeActivityRaw(driveactivity, r.fileId);
    if (acts.errorMessage) {
      console.log(`    ✗ ERROR: ${acts.errorMessage}`);
    } else {
      console.log(`    total events for this file: ${acts.totalEvents}`);
      console.log(`    First 3 events (raw JSON, looking for revisionId):`);
      for (let k = 0; k < acts.firstThreeRawJson.length; k++) {
        console.log(`    Event ${k + 1}:`);
        console.log(`      ${JSON.stringify(acts.firstThreeRawJson[k], null, 2).split('\n').join('\n      ')}`);
      }
    }

    // Verdict per file
    console.log('');
    console.log('  ── Q1+Q2 verdict for this file ──');
    const q1 = revs.count > 0;
    const q2hint = JSON.stringify(acts.firstThreeRawJson).toLowerCase();
    const q2 = q2hint.includes('revisionid') || q2hint.includes('revision_id');
    console.log(`    Q1: revisions.list returns >0?       ${q1 ? 'YES' : 'NO'}`);
    console.log(`    Q2: activity event contains revId?   ${q2 ? 'YES' : 'NO (no revisionId field found in event JSON)'}`);
  }

  console.log('');
  console.log('═══ Summary ═════════════════════════════════════════════════════════════');
  console.log(`  If Q1 = YES anywhere, revisions-walk approach works.`);
  console.log(`  If Q2 = YES anywhere, Activity API alone is sufficient.`);
  console.log(`  If both = NO across all probed files, Google-native historical content`);
  console.log(`  is not reachable through these APIs at the bot's current scope level.`);
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
