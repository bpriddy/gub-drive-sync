/**
 * probe-activity.ts — Drive Activity API feasibility probe.
 *
 * Confirms three things before we commit to the activity-API-based
 * historical-replay rearchitecture:
 *
 *   1. Authn works  — the 'drive' bot's refresh token carries the
 *      drive.activity.readonly scope. If not, you'll get a clear
 *      BotCredentialsScopeMismatchError up front; re-consent the bot
 *      with the new scope and re-run.
 *   2. Historical retention — events return for dates years ago, not
 *      just recent. Probes 7d / 30d / 1y / 2y / 3y / 4y windows.
 *   3. Response shape — fileId, revisionId, action, timestamp, actor
 *      are all extractable per event.
 *
 * Usage (LOCAL only — touches the Drive Activity API of the real Drive):
 *
 *   npm run probe-activity -- --account-id <uuid>
 *
 * Reads the account's drive_folder_id from the DB to find the ancestor
 * for the query. Set --root <folderId> to override.
 *
 * Output: per-window summary (event count, action breakdown, 3 sample
 * events) plus a yes/no readiness verdict at the end.
 */

import { google } from 'googleapis';
import { prisma } from '../src/prisma';
import { buildBotOAuthClient } from '../src/workspace';

const ACTIVITY_SCOPE = 'https://www.googleapis.com/auth/drive.activity.readonly';

interface Args {
  accountId?: string;
  rootFolderId?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out: Args = {};
  const a = get('--account-id');
  const r = get('--root');
  if (a) out.accountId = a;
  if (r) out.rootFolderId = r;
  return out;
}

function isoDaysAgo(days: number): string {
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

function isoDaysAgoPlusOneDay(days: number): string {
  const ms = (days - 1) * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

/** Pretty-print one activity record. */
function summarizeActivity(a: unknown): string {
  const act = a as {
    timestamp?: string;
    timeRange?: { startTime?: string; endTime?: string };
    actors?: Array<{ user?: { knownUser?: { personName?: string } } }>;
    primaryActionDetail?: Record<string, unknown>;
    targets?: Array<{
      driveItem?: { name?: string; title?: string; mimeType?: string };
    }>;
  };
  const time = act.timestamp ?? act.timeRange?.startTime ?? '?';
  const actionKey = Object.keys(act.primaryActionDetail ?? {})[0] ?? '?';
  const targetTitle = act.targets?.[0]?.driveItem?.title ?? '(no target)';
  const targetMime = act.targets?.[0]?.driveItem?.mimeType ?? '?';
  return `    ${time}  ${actionKey.padEnd(20)}  "${targetTitle}"  [${targetMime}]`;
}

interface WindowResult {
  label: string;
  fromIso: string;
  toIso: string;
  totalActivities: number;
  actionsBreakdown: Record<string, number>;
  pages: number;
  hadError: boolean;
  errorMessage?: string;
  sample: unknown[];
}

async function probeWindow(
  driveactivity: ReturnType<typeof google.driveactivity>,
  ancestorName: string,
  label: string,
  fromIso: string,
  toIso: string,
): Promise<WindowResult> {
  const result: WindowResult = {
    label,
    fromIso,
    toIso,
    totalActivities: 0,
    actionsBreakdown: {},
    pages: 0,
    hadError: false,
    sample: [],
  };
  try {
    let pageToken: string | undefined;
    do {
      const res = await driveactivity.activity.query({
        requestBody: {
          ancestorName,
          filter: `time >= "${fromIso}" AND time < "${toIso}"`,
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      result.pages += 1;
      const activities = (res.data.activities ?? []) as Array<{
        primaryActionDetail?: Record<string, unknown>;
      }>;
      for (const a of activities) {
        result.totalActivities += 1;
        if (result.sample.length < 3) result.sample.push(a);
        const actionKey = Object.keys(a.primaryActionDetail ?? {})[0] ?? '(unknown)';
        result.actionsBreakdown[actionKey] =
          (result.actionsBreakdown[actionKey] ?? 0) + 1;
      }
      pageToken = res.data.nextPageToken ?? undefined;
      // Safety: don't paginate forever during a probe.
      if (result.pages >= 20) {
        console.warn(`  ⚠ stopping at 20 pages for ${label} (probe safety)`);
        break;
      }
    } while (pageToken);
  } catch (err) {
    result.hadError = true;
    result.errorMessage = err instanceof Error ? err.message : String(err);
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve the ancestor folder ID.
  let rootFolderId = args.rootFolderId;
  if (!rootFolderId) {
    if (!args.accountId) {
      throw new Error(
        'Pass --account-id <uuid> (or --root <folderId> to override the lookup)',
      );
    }
    const acct = await prisma.account.findUnique({
      where: { id: args.accountId },
      select: { id: true, name: true, driveFolderId: true },
    });
    if (!acct) throw new Error(`No account with id ${args.accountId}`);
    if (!acct.driveFolderId) {
      throw new Error(`Account "${acct.name}" has no drive_folder_id set`);
    }
    rootFolderId = acct.driveFolderId;
    console.log(`Account: ${acct.name}  (${acct.id})`);
  }
  console.log(`Root folder: ${rootFolderId}`);
  console.log(`Ancestor:    items/${rootFolderId}`);
  console.log('');

  // Authenticate. Will throw a clear scope-mismatch error if the 'drive'
  // bot doesn't have drive.activity.readonly yet — that's the "fire up
  // local admin, re-consent the bot" path.
  console.log('Building OAuth client (scope: drive.activity.readonly)…');
  const auth = await buildBotOAuthClient('drive', [ACTIVITY_SCOPE]);
  const driveactivity = google.driveactivity({ version: 'v2', auth });
  console.log('  ✓ authenticated');
  console.log('');

  // The Drive Activity API's `ancestorName` accepts both regular folders
  // and shared drive roots as `items/{folderId}` — the Drive folder ID
  // and the shared drive ID are the same value for a shared drive root.
  const ancestorName = `items/${rootFolderId}`;

  // Probe a series of historical windows. Each is a 24-hour slice
  // centered on a single day in the past, to test retention depth.
  const windows: Array<{ label: string; daysAgo: number }> = [
    { label: 'last 24h',  daysAgo: 1 },
    { label: '7 days ago',  daysAgo: 7 },
    { label: '30 days ago', daysAgo: 30 },
    { label: '6 months ago', daysAgo: 180 },
    { label: '1 year ago',   daysAgo: 365 },
    { label: '2 years ago',  daysAgo: 365 * 2 },
    { label: '3 years ago',  daysAgo: 365 * 3 },
    { label: '4 years ago',  daysAgo: 365 * 4 },
  ];

  const results: WindowResult[] = [];
  for (const w of windows) {
    const fromIso = isoDaysAgo(w.daysAgo);
    const toIso = isoDaysAgoPlusOneDay(w.daysAgo);
    process.stdout.write(`Probing ${w.label.padEnd(15)}  (${fromIso.slice(0, 10)})… `);
    const r = await probeWindow(driveactivity, ancestorName, w.label, fromIso, toIso);
    if (r.hadError) {
      console.log(`✗ ERROR: ${r.errorMessage}`);
    } else {
      console.log(`✓ ${r.totalActivities} activities (${r.pages} pages)`);
    }
    results.push(r);
  }

  console.log('');
  console.log('═══ Per-window details ═══════════════════════════════════════');
  for (const r of results) {
    console.log('');
    console.log(`▸ ${r.label}  ${r.fromIso.slice(0, 10)} → ${r.toIso.slice(0, 10)}`);
    if (r.hadError) {
      console.log(`  ERROR: ${r.errorMessage}`);
      continue;
    }
    console.log(`  Total: ${r.totalActivities}  (${r.pages} page${r.pages === 1 ? '' : 's'})`);
    if (Object.keys(r.actionsBreakdown).length > 0) {
      console.log('  By action:');
      for (const [action, count] of Object.entries(r.actionsBreakdown).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`    ${action.padEnd(24)} ${count}`);
      }
    }
    if (r.sample.length > 0) {
      console.log('  Sample:');
      for (const a of r.sample) console.log(summarizeActivity(a));
    }
  }

  // ── Readiness verdict ──────────────────────────────────────────────
  console.log('');
  console.log('═══ Verdict ════════════════════════════════════════════════');
  const recentOk = results.find((r) => r.label === 'last 24h')?.totalActivities ?? 0;
  const oneYearOk = (results.find((r) => r.label === '1 year ago')?.totalActivities ?? 0) > 0
    || (results.find((r) => r.label === '6 months ago')?.totalActivities ?? 0) > 0;
  const deepOk =
    (results.find((r) => r.label === '2 years ago')?.totalActivities ?? 0) > 0
    || (results.find((r) => r.label === '3 years ago')?.totalActivities ?? 0) > 0
    || (results.find((r) => r.label === '4 years ago')?.totalActivities ?? 0) > 0;
  const anyErrors = results.some((r) => r.hadError);

  console.log(`  ${recentOk > 0 ? '✓' : '✗'}  Recent activities (24h):       ${recentOk}`);
  console.log(`  ${oneYearOk ? '✓' : '✗'}  Has 6mo-1y depth`);
  console.log(`  ${deepOk ? '✓' : '✗'}  Has 2y+ depth (real backfill window)`);
  console.log(`  ${anyErrors ? '✗' : '✓'}  No errors during paging`);
  console.log('');

  if (recentOk > 0 && deepOk && !anyErrors) {
    console.log('🟢  Drive Activity API is viable for the historical-replay redesign.');
  } else if (recentOk > 0 && oneYearOk && !anyErrors) {
    console.log('🟡  API works but historical depth is limited. Confirm retention policy.');
  } else if (anyErrors) {
    console.log('🔴  Errors encountered — check the per-window details above.');
  } else {
    console.log('🔴  Insufficient depth — Activity API may not cover the catchup window.');
  }
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
