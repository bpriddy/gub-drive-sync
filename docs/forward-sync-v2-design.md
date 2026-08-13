# Forward-sync v2 — design (Phase 1 of the v2 arc)

Status: DRAFT for team review, 2026-08-13. Builds on the scan-core
extraction (`src/scan/` — PR `v2/scan-core-extraction`) and the decision
record in [edit-stats-decision.md](./edit-stats-decision.md) (scope
granted + probe-verified: Activity API live, ~1y retention on Chevy).

## What Phase 1 delivers

A real forward driver: instead of re-walking `modifiedTime` buckets (the
current "forward" stub), each run asks the Drive Activity API "what
happened since the cursor", scans exactly those files, stamps
observations with the **real event days**, and tallies per-editor edit
events into a new `drive_edit_stats` table from the same stream.

The scan core is untouched — the driver builds `ProcessBatchOptions`
and hands over batches, exactly like the day-walk driver.

## The driver loop (per account, per queue row)

1. **Window.** Read `accounts.drive_forward_cursor_at` (new TIMESTAMPTZ;
   initialized to bootstrap completion time). Window = (cursor, now].
2. **Query.** `activity.query` with `ancestorName: items/<root>` +
   time filter, paginated to exhaustion. One query per account per run —
   no per-file fan-out.
   - Note: the Activity API has **no persistent change token** (that was
     a misdesign in the old plumbing — `drive_activity_page_token` and
     the `activity_page_token_in/out` chunk columns assume changes.list
     semantics the Activity API doesn't have). The cursor is a
     timestamp; `pageToken` only pages within one query. The token
     columns get dropped in Phase 2.
3. **Fold events** into: changed `fileId` set, per-file **event days**,
   per-(file, day, actor) edit counts, deletion/trash events.
4. **Batch by event day**, oldest first — a catch-up window spanning
   several days becomes several serial one-day batches, preserving the
   supersede chronology and the engine's one-day invariant. Fetch
   current metadata for the changed files (they enter the batch like
   any discovery result; content is current-state, per doctrine).
5. **Structure**: same path as today — cheap re-gather + fingerprint;
   LLM re-classify only on drift.
6. **Per day-group**: `processBatch(files, { …, editedAt: <event day> })`.
   The day-commit gate applies: stage-3 failure → throw → queue retry
   re-runs from the last committed cursor.
7. **Advance cursor** after each committed day-group (crash-safe);
   final group advances it to the window end.
8. **Edit stats**: upsert the (file, day, actor) tallies gathered in
   step 3. Stats commit with their day-group.

Dispatch: `backfill-queue.processOne` routes by `req.mode` —
`'bootstrap'` → `runBackfill` (day-walk), `'forward'` → `runForward`
(this driver, `src/forward/`). The admin **Sync** button already
enqueues forward rows, so it starts exercising the real driver the day
this merges. Interval scheduling stays OFF until Phase 2 (the parked
`forward-enqueue` shell returns then, in final form).

## Edit stats

- **Table** (grain locked by the decision record):
  `drive_edit_stats(account_id, file_id, day DATE, actor_email TEXT,
  edit_count INT, captured_at)` — PK `(file_id, day, actor_email)`.
  Campaign attribution resolved at **query time** (minimal-DB doctrine;
  merges don't stale it).
- **Actor resolution — the one new moving part.** Activity actors are
  `people/<id>` resource names, not emails. Resolve via the People API
  using the **directory bot's** existing credential (contacts +
  directory scopes already granted — no new consent), cached in a small
  `people_resource_map` table. Unresolvable actors persist as the raw
  resource name rather than being dropped (all-editors-or-nothing
  principle).
- **Historical seed**: one-shot `seed-edit-stats` mode replaying
  windowed Activity queries back ~1 year (the probe-verified horizon),
  run once per account at validation. Forward ticks maintain it after.
- **Admin surface (minimal)**: "Editor activity" panel on the account's
  data-sources page — per-editor event counts, last 30 days, resolved
  against staff names where emails match. Anything fancier waits for a
  real need.

## Explicit non-goals (Phase 1)

- **Deletions/trashes**: counted + logged, not applied. Dossiers are
  memory, not a mirror; how (whether) deletions should surface is a
  Phase 2+ conversation.
- **v1 retirement, interval scheduling, phantom cleanup**: Phase 2.
- **Per-editor content attribution**: impossible on public APIs —
  settled in the decision record; do not reopen.

## Schema changes (GUB canonical + 2 mirrors, per doctrine)

1. `accounts.drive_forward_cursor_at TIMESTAMPTZ NULL`
2. `drive_edit_stats` table + `people_resource_map` cache table
3. (Phase 2, noted now: drop `drive_activity_page_token`,
   `drive_sync_runs.activity_page_token_in/out`.)

## Validation plan (pre-live, DB nukeable)

1. Dev, Chevy: set cursor = bootstrap completion; make a handful of
   real Drive edits; run one forward row via admin Sync; verify dossier
   deltas carry the real event day and `drive_edit_stats` rows appear
   with resolved emails.
2. Full-circle: nuke, re-bootstrap, forward tick, seed-edit-stats;
   confirm chronology (bootstrap days < forward days) and stats sanity
   against the Activity probe's counts.
3. Only then: Phase 2 (retire v1, activate the interval in final form).

## Open questions for review (defaults applied unless vetoed)

1. Actor resolution via the directory bot's People API — acceptable
   credential reuse? (Default: yes; it's read-only profile→email.)
2. Deletion policy = count + log only — acceptable for Phase 1?
3. Run the ~1y historical seed at validation? (Default: yes — same
   query, wider window, one-shot.)
4. Cursor-timestamp overlap: window edges use a 2-minute lookback
   overlap to absorb Activity API ingestion lag; upserts + the engine's
   idempotent merge make double-processing harmless. Objections?
