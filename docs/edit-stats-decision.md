# Editor edit-stats: decision record

**Decided 2026-07-20. Status: approved, not built — ships WITH forward-sync-v2,
not before it.** This doc exists so the forward-sync-v2 design pass starts
from the settled decision instead of re-litigating it.

## The decision

Track a **coarse per-editor activity metric**: Drive Activity API edit events,
tallied per **file × day × editor**. Accepted as fuzzy by design — the event
unit is Google's opaque session bucketing, so a typo and a rewrite can count
the same. This is a "who is actually working on what, day to day" signal,
**not** a contribution-volume or productivity metric, and it must never be
presented as one.

Edit-stats are a **byproduct of Activity-driven forward sync**: the same
`activity.query` stream that tells forward sync which files changed also
carries `{fileId, action, timestamp, actor}` per event. One token, one
consumer, no second Activity integration. That is why the build is folded
into forward-sync-v2 rather than shipped as an independent capture job
(the independent-job option was considered and rejected 2026-07-20 — it
starts the data clock sooner but leaves two Activity consumers to
reconcile forever).

## Why not revisions (settled — do not reopen)

`revisions.list` was removed from the backfill engine entirely (commit
2dc39ba). It cannot honestly answer "who edited this":

- Each revision names ONE `lastModifyingUser`; co-editors' work is silently
  credited to whoever saved last. Fails the ruling that we track individual
  editors **only if ALL of them are tracked**.
- Binary revisions are pruned at ~30 days / 100 revisions; Google-native
  revisions are consolidated over time. Historical counts systematically
  undercount older work — worse than no data when the subject is people.
- The richer shape (per-editor arrays of actual edit content) is not
  obtainable from ANY public Google API. The colored per-editor diffs in
  the Docs UI come from an internal changelog that Docs/Drive/Activity/Apps
  Script do not expose. There is no supported "what words did John write."

The Activity API is the only source that records **every** actor's edit
events (including simultaneous co-editing), which is what makes the
all-editors bar reachable at event granularity.

## Verified facts (probe-activity, Chevy drive, 2026-07-20)

- Bot scope **granted**: `drive.activity.readonly` consented via
  gub-bot-oauth (the scope was an uncommitted edit in `src/bots.ts`;
  committed ff5ca7a and deployed BEFORE re-consent — a re-auth against the
  stale deploy would have silently granted the old scope list).
- API live, no errors while paging. 85 events in the trailing 24h; actions
  typed (edit / create / move / rename / delete) with actor + timestamp.
- **Retention reaches ≥1 year, zero at 2y+** (167 events at 1y, 292 at
  6mo, 0 at 2/3/4y). Ambiguous whether that is a Google retention cliff or
  the shared drive's age (files moved INTO a drive don't carry prior
  activity). Practical read: a ~1-year historical seed is available;
  older is unreachable.

## Locked shape

One table, one row per file × day × editor:

```prisma
model DriveEditStat {
  accountId   String   @db.Uuid
  fileId      String
  day         DateTime @db.Date
  editorEmail String
  editCount   Int          // Activity 'edit' events that day
  capturedAt  DateTime

  @@id([fileId, day, editorEmail])
  @@index([accountId, day])
  @@map("drive_edit_stats")
}
```

Migration lands in GUB (canonical) and mirrors to gub-drive-sync +
gub-admin, applied ×3, per the standing pattern. Admin gets a visibility
surface (per-account / per-campaign editor rollups); design follows the
existing data-sources page patterns.

## Open at v2 design time (the ONLY open questions)

1. **Campaign attribution** — denormalize nullable `campaignId` at capture
   (fast rollups, stale on merges) vs resolve file→campaign at query time.
   Current lean: query-time, per minimal-DB doctrine.
2. **Edits only vs all actions** — stream hands us create/rename/move/delete
   free. Current lean: `editCount` only; widen when a need appears.
3. **~1y historical seed vs forward-only** — same query, wider window,
   nearly free at build time. Decides whether the surface starts with a
   year of history or from day one.

## Plumbing that already exists

- `accounts.drive_activity_page_token` — per-account Activity cursor
  (NULL today; forward-sync-v2 advances it)
- `drive_sync_runs.activity_page_token_in/out` — per-chunk token handoff
- `scripts/probe-activity.ts` — the feasibility probe; re-runnable any time
- Forward mode in the v2 queue is currently a LABEL (runs the bootstrap
  day-walk regardless of `mode`); replacing that stub with Activity-driven
  delta IS forward-sync-v2, and edit-stats ride that build.
