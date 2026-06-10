# Drive Sync v2 — Bootstrap + Forward

**Status**: Proposal — pending review
**Date**: 2026-06-10
**Supersedes**: The createdTime-based backfill architecture in `scripts/backfill.ts`

---

## Context

The current "backfill" model walks Drive history by `createdTime`, processing
each file once on its creation date with **today's** content. It stamps the
resulting observations and status_markdown bullets with `_edited_at: <historical>`
— but the underlying facts are extracted from current content. This is a lie
that the architecture cannot fix:

1. Google's Drive API v3 explicitly **does not** support content download for
   historical revisions of Workspace files (Docs/Sheets/Slides).
2. The v2 workaround (revisions endpoint exposes `exportLinks`) requires
   `Editor`/`Content Manager`/`Owner` role on every file. Bot is currently
   `Viewer`.
3. Even with role elevation + the v2 workaround, Google auto-merges historical
   revisions for Workspace files. **`keepForever` is not supported for Workspace
   files at all** — Google decides retention.
4. For older content (months/years), Google's auto-merge collapses edit history
   into sparse checkpoints. Day-granular reconstruction is not achievable.

The current backfill therefore produces **misdated knowledge**: temporally-
stamped data that pretends to be historical but is current.

## Decision

Drop the historical-reconstruction promise. Replace with two honest modes:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   bootstrap (one-time per account)                              │
│     • Discover every file in the drive                          │
│     • Extract observations from current content                 │
│     • Stamp with scanned_at = today                             │
│     • Status_markdown header says "as of <scan date>"           │
│     • Chunked across Cloud Run Job executions                   │
│                                                                 │
│   forward (daily, end-of-day, per account)                      │
│     • Cloud Scheduler triggers Job                              │
│     • Activity API: changes since last pageToken                │
│     • Unique edited files in window → re-extract                │
│     • Stamp observations with actual edit time                  │
│     • Status_markdown header reflects actual edit time          │
│     • Chunked when a single poll's changeset is too large       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

No claims about state before bootstrap. No retroactive timestamps. From
bootstrap onward, real history accumulates organically through forward sync.

## What stays from the current codebase

The LLM pipeline is type-correct and can be reused as-is:

- `extractText` — reads current bytes, parses to text. Works.
- `interpretFile` — per-file LLM observations. Works.
- Folder→entity structure resolution + attribution. Works.
- Per-entity distillation. Works.
- Per-entity synthesis (now parallelized at concurrency 8). Works.
- Pre-filter skip-able files (mime/size). Works.
- 2Gi memory, heap watcher, heartbeat-based crash recovery. Works.
- `runWithConcurrency` worker-pool primitive. Works.
- Cloud Run Job + continuation-via-Admin-API chunking mechanism. Works.

## What gets rewritten or removed

| Component | Action |
|---|---|
| `scripts/backfill.ts` `runBackfillInner` main loop | Replace mode dispatch; route to bootstrap or forward |
| `groupFilesByDate` / `activeDates` / `nextDay` walker | **Delete** |
| `drive_backfill_cursor` column on `accounts` | Drop |
| `drive_backfill_requests` table | Rename to `drive_sync_runs` + add `mode` column |
| `scans` / `scans_done` columns on the queue table | Drop (no longer day-based) |
| Distillation prompt — "as of historical day D" framing | Update to scan-time framing |
| Synthesis prompt — quad-output's per-day stamping | Update to scan-time + actual-edit-time framing |
| `_edited_at:` header in status_markdown | Reframe as "as of last scan" or "edited on" |
| Per-file LLM temporal grounding (`entity_campaign_name` historical rules) | Relax (no longer relevant) |
| `accounts.status_markdown` / `status_sensitive_markdown` content | Wipe before bootstrap |
| `account_changes` / `campaign_changes` from backfill writes | Wipe |
| `drive_change_proposals` from backfill | Wipe |
| Backfill-created campaign rows | Audit and decide per row (some may be real) |

## New schema

### Migration

```sql
-- Rename for clarity (the table is no longer about "backfill")
ALTER TABLE drive_backfill_requests RENAME TO drive_sync_runs;

-- Mode discriminator
ALTER TABLE drive_sync_runs
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'bootstrap'
    CHECK (mode IN ('bootstrap', 'forward'));

-- Bootstrap progress: where we are in the file-list pagination
ALTER TABLE drive_sync_runs
  ADD COLUMN bootstrap_cursor TEXT NULL;  -- "lastFileId" from files.list

-- Forward progress: where we are in the Activity API stream
ALTER TABLE drive_sync_runs
  ADD COLUMN activity_page_token_in  TEXT NULL,
  ADD COLUMN activity_page_token_out TEXT NULL;

-- Drop columns that no longer apply
ALTER TABLE drive_sync_runs
  DROP COLUMN scans,
  DROP COLUMN scans_done;

-- Account-level state
ALTER TABLE accounts
  ADD COLUMN drive_bootstrap_completed_at  TIMESTAMPTZ NULL,
  ADD COLUMN drive_last_synced_at          TIMESTAMPTZ NULL,
  ADD COLUMN drive_activity_page_token     TEXT NULL,
  DROP COLUMN drive_backfill_cursor;

-- Rename the live-status column for consistency
ALTER TABLE accounts
  RENAME COLUMN drive_last_scanned_at TO drive_last_run_at;
```

(Schema mirror across the three repos — same banner pattern we've used.)

### `drive_sync_runs` final shape

| column | purpose |
|---|---|
| `id` | UUID PK |
| `account_id` | which account this run is for |
| `mode` | 'bootstrap' or 'forward' |
| `status` | 'pending' / 'running' / 'completed' / 'failed' |
| `requested_by` | staff who triggered (or system-staff for scheduler-triggered) |
| `requested_at` | when |
| `started_at` | claim time |
| `completed_at` | terminal time |
| `last_heartbeat_at` | engine pulse (15-min stale threshold) |
| `attempts` | retry count |
| `next_attempt_at` | retry-backoff schedule |
| `all_remaining` | true → continuation chain until fully done |
| `bootstrap_cursor` | last-processed fileId in the bootstrap walk |
| `activity_page_token_in` | Activity API token at the START of a forward chunk |
| `activity_page_token_out` | Activity API token at the END of a forward chunk |
| `files_processed` | files actually extracted in this chunk |
| `error_message` | terminal-failure detail |
| `log_summary` | tail of engine output |

The `all_remaining` flag + heartbeat + scheduleContinuation pattern carries
over unchanged. We're just changing what "advance the cursor" means inside
the engine.

## Bootstrap mode — engine pseudocode

```
runBootstrap(accountId):
  ctx = loadEntity(accountId)
  attributor, nameDirectory = resolveStructure(ctx)   # existing code
  fileListPageToken = read drive_sync_runs.bootstrap_cursor for this run
  
  while wall-clock budget remaining:
    page = drive.files.list({
      driveId: ctx.driveFolderId,
      corpora: 'drive',
      pageSize: 100,
      pageToken: fileListPageToken,
      ...
    })
    
    extractable = page.files.filter(predictExtractionSkip == null)
    
    for file in extractable:
      observations = await processOneFile(file, attributor, ctx)
      bucket(observations) by entity
    
    # Distill + synthesize the entities touched in this page, in parallel
    await runWithConcurrency(touchedEntities, SYNTH_CONCURRENCY, async (entity) =>
      distill + synth + write
    )
    
    fileListPageToken = page.nextPageToken
    persist bootstrap_cursor = fileListPageToken
    files_processed += extractable.length
    
    if not page.nextPageToken:
      mark run completed
      mark account.drive_bootstrap_completed_at = now
      break
  
  if not completed and account.allRemaining:
    scheduleContinuation()   # existing Admin API call
```

Synthesis is "merge into the entity's existing status_markdown." Across many
chunks, an entity may have observations from chunk #1 already persisted; when
chunk #5 touches the same entity, synthesis merges in the new observations.
The Activity API isn't used in bootstrap.

## Forward mode — engine pseudocode

```
runForward(accountId):
  ctx = loadEntity(accountId)
  attributor, nameDirectory = resolveStructure(ctx)
  pageTokenIn = account.drive_activity_page_token   # may be null on first run
  
  if pageTokenIn is null:
    pageTokenIn = drive.activity.getStartPageToken()
    # first forward run after bootstrap establishes the token
  
  changedFileIds = Set()
  pageToken = pageTokenIn
  
  while wall-clock budget remaining:
    page = drive.activity.query({
      ancestorName: "items/<drive root>",
      filter: ...,                  # optional, see below
      pageSize: 100,
      pageToken: pageToken,
    })
    
    for activity in page.activities:
      if action ∈ {CREATE, EDIT, MOVE, RENAME}:
        fileId = activity.target.driveItem.fileId
        changedFileIds.add(fileId)
    
    pageToken = page.nextPageToken
    
    if pageToken is null:
      break   # caught up to current
  
  # Process changed files (current content, real edit time stamped via activity)
  for fileId in changedFileIds:
    process(fileId)
    
  bucket → distill → synth (parallel) → write
  
  persist account.drive_activity_page_token = pageToken
  persist account.drive_last_synced_at = now
  mark run completed
```

When a single poll's changeset is too large to process within the wall-clock
budget, `all_remaining=true` triggers continuation — same chain mechanic.

For deletes: detect DELETE activities and prune the file's observations from
the entity's status_markdown if it dominated any bullet (this is a refinement,
not required for v1).

## Prompt updates

### Per-file LLM (`drive.file_extraction.v1`)

- Drop "as of <historical date>" framing in the prompt
- Drop the `entity_campaign_name` temporal grounding rules (no longer relevant
  since we're not reconciling against historical state)
- Add: "this content was read on <scanned_at>; observations should reflect
  what's currently in the file"

### Distillation (`drive.distillation.v1`)

- Drop "historical day" framing
- Simplify: observations → field_changes + notes from the entity's current
  knowledge

### Synthesis (status_synthesis_v1)

- Drop the "merge as if this is a snapshot from day D" framing
- The `editedAt` parameter becomes:
  - Bootstrap mode: today's scan date (with header "as of <date> (bootstrap scan)")
  - Forward mode: actual edit timestamp from Activity API
- Pre-prune of expired transient bullets uses the same `editedAt` value
- Quad-output schema unchanged (general + sensitive)

## UI changes

The `Data Sources / Drive` page in gub-admin gets two buttons per account:

- **Bootstrap** (visible when `drive_bootstrap_completed_at IS NULL`)
- **Sync now** (visible when bootstrap is complete; triggers an immediate
  forward run instead of waiting for the scheduler)

Plus a status indicator showing:
- Bootstrap progress: "X of Y files processed" while running
- Forward sync state: "Last synced N hours ago"

Plus the existing recent-runs table (renamed from "Recent backfill requests"
to "Recent sync runs"), with mode badge per row.

## Cloud Scheduler integration

A new Cloud Scheduler job triggers the forward-sync Cloud Run Job daily at
the configured time (UTC end-of-business-day, e.g. 02:00 UTC = 9 PM Eastern
previous day). It calls Job:run with `containerOverrides.args = ['forward-all']`.

The forward-all mode loops every account where `bootstrap_completed_at IS NOT NULL`,
creates a `drive_sync_runs` row with `mode='forward'`, and triggers the same
queue-drain pattern we already use.

## Nuke script (run BEFORE the new engine ships)

```sql
BEGIN;
-- Wipe all backfill-generated data
DELETE FROM account_changes WHERE changed_by = 'dcd5d8e3-0000-4000-a000-000000000001';
DELETE FROM campaign_changes WHERE changed_by = 'dcd5d8e3-0000-4000-a000-000000000001';
DELETE FROM drive_change_proposals;
DELETE FROM drive_scan_logs;
DELETE FROM drive_backfill_requests;

-- Reset account-level Drive state
UPDATE accounts SET
  status_markdown = NULL,
  status_sensitive_markdown = NULL,
  drive_backfill_cursor = NULL,
  drive_last_scanned_at = NULL;

-- Reset campaign-level state (auto-created candidates may need audit)
UPDATE campaigns SET
  status_markdown = NULL,
  status_sensitive_markdown = NULL;

-- Optional: review backfill-auto-created campaigns case-by-case before deleting
-- (some may be real campaigns operators want to keep)
COMMIT;
```

This runs once, manually, against the dev DB before the new engine deploys.
Then schema migration runs. Then new engine deploys.

## Threat model / bot scope

**Unchanged.** The bot stays at `drive.readonly` + `drive.activity.readonly`
scopes. Viewer/Commenter role on production drives is sufficient for both
modes — Activity API works at this role, files.list works at this role,
current-content extraction works at this role.

No push to elevate the bot to Editor or Content Manager. The original
"Auth: No DWD Decision" posture holds.

## Open questions

1. **Should bootstrap process every file or filter?** Decision: every file
   (per Ben). Pre-filter skip-able files (mime/size) is just the same
   skip-logic we already have — no new filtering.

2. **Cloud Scheduler config — what time?** Default: 02:00 UTC daily (≈ 9 PM
   Eastern, business-day end). Configurable in terraform.

3. **What's the granularity of "forward sync changeset"?** Activity API returns
   events; we group unique fileIds within the poll window. A file edited 50
   times in a day gets processed once with current content, stamped with the
   LATEST edit time.

4. **Migration sequencing?**
   - Step 1: Land all this code in feature branches; don't merge.
   - Step 2: Drop existing Cloud Scheduler trigger that fires backfill.
   - Step 3: Run nuke script against dev DB.
   - Step 4: Run schema migration.
   - Step 5: Deploy new engine.
   - Step 6: Click Bootstrap on Chevy. Verify chunked completion.
   - Step 7: Manually trigger first forward sync. Verify Activity API token
     gets persisted.
   - Step 8: Wire up Cloud Scheduler for daily forward sync.

5. **Campaign rollback strategy?** Some backfill-auto-created campaigns may
   represent real campaigns. Before the nuke, dump the list of
   `campaigns WHERE created_by = system-staff` and review with the operator.
   Keep the real ones; delete the noise.

## Acceptance criteria

- [ ] Bootstrap a fresh account, see every file processed, status_markdown
      contains accurate observations stamped with bootstrap date
- [ ] Forward sync polls Activity API, processes only changed files, stamps
      with actual edit timestamps
- [ ] No claims of historical fidelity anywhere in the output
- [ ] Cloud Scheduler triggers daily forward sync without operator action
- [ ] Bootstrap can complete via continuation chain on Chevy-sized drives
      (25k+ files)
- [ ] Forward sync gracefully handles days with thousands of activity events
- [ ] Existing extraction/distill/synth/parallelism all carry over without
      regression

## Out of scope

- Historical content reconstruction (impossible at the API level)
- Bot role elevation (not needed)
- Real-time push notifications (forward sync's daily cadence is enough; push
  can be a follow-up)
- Multi-drive-per-account (existing constraint: one drive root per account)
