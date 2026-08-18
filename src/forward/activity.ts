/**
 * forward/activity.ts — Drive Activity API client + event folding.
 *
 * The forward driver's delta source: one `activity.query` per account
 * per run, ancestor-scoped to the account's Drive root, bounded by a
 * timestamp window. NO change token exists on this API — `pageToken`
 * only pages within a single query (see docs/forward-sync-v2-design.md,
 * "the driver loop", note on the old token-column misdesign).
 *
 * Auth: the 'drive' bot's OAuth credential with the
 * drive.activity.readonly scope (granted + probe-verified 2026-07-20;
 * see docs/edit-stats-decision.md).
 *
 * Output is NORMALIZED events; folding into the changed-file set and
 * whole-window per-(file, actor) edit tallies lives here too so the
 * driver and the seed-edit-stats mode share one implementation.
 */

import { google, type driveactivity_v2 } from 'googleapis';
import { logger } from '../logger';
import { buildBotOAuthClient } from '../workspace';

const ACTIVITY_SCOPE = 'https://www.googleapis.com/auth/drive.activity.readonly';

export type ActivityAction =
  | 'edit'
  | 'create'
  | 'delete'
  | 'move'
  | 'rename'
  | 'restore'
  | 'other';

export interface ActivityEvent {
  fileId: string;
  /** Item title at event time (display only — metadata refetch is truth). */
  fileTitle: string | null;
  /** ISO timestamp of the event (timeRange end for consolidated ones). */
  timestamp: string;
  action: ActivityAction;
  /** Raw actor resource ("people/<id>"), null for system/anonymous actors. */
  actorResource: string | null;
}

let cachedClient: driveactivity_v2.Driveactivity | null = null;

async function activityClient(): Promise<driveactivity_v2.Driveactivity> {
  if (cachedClient) return cachedClient;
  const auth = await buildBotOAuthClient('drive', [ACTIVITY_SCOPE]);
  logger.info('[forward.activity] initialized Drive Activity client (drive bot OAuth)');
  cachedClient = google.driveactivity({ version: 'v2', auth });
  return cachedClient;
}

function classifyAction(detail: driveactivity_v2.Schema$ActionDetail | undefined): ActivityAction {
  if (!detail) return 'other';
  if (detail.edit) return 'edit';
  if (detail.create) return 'create';
  if (detail.delete) return 'delete';
  if (detail.move) return 'move';
  if (detail.rename) return 'rename';
  if (detail.restore) return 'restore';
  return 'other';
}

/** "items/<fileId>" → "<fileId>"; null for non-driveItem targets. */
function targetFileId(target: driveactivity_v2.Schema$Target | undefined): {
  id: string | null;
  title: string | null;
} {
  const item = target?.driveItem;
  if (!item?.name) return { id: null, title: null };
  return { id: item.name.replace(/^items\//, ''), title: item.title ?? null };
}

/**
 * Query all activity under `rootFolderId` in (fromIso, toIso], paginated
 * to exhaustion. Each activity may carry several actions/targets — we
 * emit one normalized event per (action × driveItem target).
 *
 * Consolidation note: the API groups related actions; a consolidated
 * activity's timestamp is its timeRange END. For edit tallies this
 * undercounts bursts (N rapid edits → 1 event) — accepted, the metric
 * is "edit events", not keystrokes (docs/edit-stats-decision.md).
 */
export async function queryActivityWindow(
  rootFolderId: string,
  fromIso: string,
  toIso: string,
): Promise<ActivityEvent[]> {
  const client = await activityClient();
  const events: ActivityEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.activity.query({
      requestBody: {
        ancestorName: `items/${rootFolderId}`,
        filter: `time > "${fromIso}" AND time <= "${toIso}"`,
        pageSize: 500,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    for (const activity of res.data.activities ?? []) {
      const ts =
        activity.timestamp ?? activity.timeRange?.endTime ?? null;
      if (!ts) continue;
      // One actor per normalized event: the first user actor. Multi-actor
      // consolidated activities are rare; per-actor fidelity comes from
      // the fact that co-editing sessions produce per-actor activities.
      const actorResource =
        activity.actors?.find((a) => a.user?.knownUser?.personName)?.user
          ?.knownUser?.personName ?? null;
      for (const action of activity.actions ?? []) {
        const kind = classifyAction(action.detail);
        // Action-level target wins; fall back to the activity's targets.
        const targets =
          action.target ? [action.target] : (activity.targets ?? []);
        for (const t of targets) {
          const { id, title } = targetFileId(t);
          if (!id) continue;
          events.push({
            fileId: id,
            fileTitle: title,
            timestamp: action.timestamp ?? ts,
            action: kind,
            actorResource,
          });
        }
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return events;
}

// ── Folding ──────────────────────────────────────────────────────────────────

export interface FoldedWindow {
  /** YYYY-MM-DD (UTC) → set of fileIds touched that day (delete-only files excluded). */
  filesByDay: Map<string, Set<string>>;
  /** Edit-event tallies: `${fileId}|${actorResource}` → count for the
   *  WHOLE window (run framing — the run supplies the date; event days
   *  never key stats). */
  editTallies: Map<string, number>;
  /** All distinct actor resources seen in edit events (for batch resolution). */
  actorResources: Set<string>;
  /** Deletion/trash events observed — logged, never applied (design Q2). */
  deletionEvents: number;
  totalEvents: number;
}

export function ymdUtc(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Fold raw events into the two shapes the driver needs: per-day changed
 * file sets (for the changed-file union + logging) and whole-window
 * per-(file, actor) edit tallies (run framing).
 * Files whose ONLY events are deletions don't enter scan batches (their
 * content is gone; dossiers don't react — Q2), but delete events still
 * count toward deletionEvents for the run log.
 */
export function foldEvents(events: ActivityEvent[]): FoldedWindow {
  const filesByDay = new Map<string, Set<string>>();
  const editTallies = new Map<string, number>();
  const actorResources = new Set<string>();
  let deletionEvents = 0;

  for (const e of events) {
    const day = ymdUtc(e.timestamp);
    if (e.action === 'delete') {
      deletionEvents++;
      continue;
    }
    let set = filesByDay.get(day);
    if (!set) {
      set = new Set();
      filesByDay.set(day, set);
    }
    set.add(e.fileId);

    if (e.action === 'edit' || e.action === 'create') {
      const actor = e.actorResource ?? '(unattributed)';
      actorResources.add(actor);
      const key = `${e.fileId}|${actor}`;
      editTallies.set(key, (editTallies.get(key) ?? 0) + 1);
    }
  }

  return {
    filesByDay,
    editTallies,
    actorResources,
    deletionEvents,
    totalEvents: events.length,
  };
}
