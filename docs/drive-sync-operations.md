# Drive Sync — Operations Runbook

How to run, monitor, and troubleshoot drive sync. For architecture,
schema, and data flow see [`drive-sync.md`](./drive-sync.md).

---

## Quick reference

| Task | Command / location |
|---|---|
| Bootstrap an account | gub-admin → Data Sources → Google Drive → click **Backfill** |
| Force a forward sync | gub-admin → Data Sources → Google Drive → click **Sync** (after bootstrap completes) |
| Cancel a stuck run | gub-admin → Data Sources → Google Drive → Recent runs → click **✕** |
| View per-run logs | gub-admin → Recent runs → hover Summary cell; full text via Cloud Run logs |
| Watch live progress | Cloud Run console → Job → Executions → tail logs |
| Drain locally during dev | `cd gub-drive-sync && npm run backfill-pending` |
| Run one chunk directly | `cd gub-drive-sync && npm run backfill -- --account-id <uuid>` |
| Clear an account's drive data | `cd gub-drive-sync && npm run clear -- --account-id <uuid>` |

---

## Bootstrapping a new account

The first time an account starts collecting Drive knowledge.

### Prerequisites

- Account exists in DB with a non-NULL `drive_folder_id` (set via
  gub-admin's Data Sources page).
- Bot user (`<drive-bot>@<workspace-domain>`) has been shared on the
  account's Drive folder with at least Viewer/Commenter access.
- Bot's OAuth scopes include:
  - `drive.readonly`
  - `documents.readonly` / `presentations.readonly` / `spreadsheets.readonly`
  - `drive.activity.readonly` (used by forward sync)

### Process

1. Operator clicks **Backfill** on the per-account row.
2. gub-admin writes a row to `drive_sync_runs` with `mode='bootstrap'`,
   `status='pending'`, `all_remaining=true`.
3. gub-admin calls Cloud Run Admin API → fires the gub-drive-sync Job
   with args `['backfill-pending']`.
4. Job starts. `processBackfillQueue`:
   - `reclaimStaleRunning` resets any zombie rows.
   - Claims the row via SKIP-LOCKED.
   - Heartbeat ticker starts (5-min interval).
5. Engine (`runBackfillInner`):
   - Chunk #1 path: gather folders, LLM classify, discover files, bucket
     by modifiedTime, persist both cache columns. **~5 min prelude.**
   - Picks the oldest active day. Processes that day's files via the
     per-file → per-entity LLM pipeline.
   - Persists cursor + status_markdowns + change rows.
6. Queue: detects `all_remaining=true` AND `bootstrapCompleted=false` →
   writes a continuation row, calls Admin API, exits the drain loop.
7. New Job execution starts. Chunk #2:
   - **Cache HIT** on structure + files. Skips the prelude (~10s vs ~5
     min).
   - Walks to the next active day from the cursor.
   - Same process; queues continuation.
8. Repeats until cursor catches today. `persistCursor` with
   `setCompleted=true`:
   - Sets `accounts.drive_bootstrap_completed_at = now()`.
   - NULLs `accounts.drive_bootstrap_files` (large payload no longer
     useful).
   - Leaves `accounts.drive_structure_classification` intact (forward
     sync will inherit).
9. Continuation chain doesn't fire (bootstrap is complete). Chain ends.

### What "done" looks like

```sql
SELECT
  name,
  drive_bootstrap_cursor,
  drive_bootstrap_completed_at,
  drive_bootstrap_files IS NULL AS files_cache_freed,
  drive_structure_classification IS NOT NULL AS structure_cache_kept
FROM accounts
WHERE id = '<account_uuid>';
```

Expect:
- `drive_bootstrap_cursor` close to today's date
- `drive_bootstrap_completed_at` non-NULL
- `files_cache_freed = true`
- `structure_cache_kept = true`

The UI's per-account row shifts from "Backfill" to "Sync" button after
this (the operator-facing label switches based on bootstrap state).

---

## Forward sync (after bootstrap)

Once bootstrap completes, the account moves to forward sync, the
Activity-driven driver in `src/forward/run.ts` (design:
[`forward-sync-v2-design.md`](./forward-sync-v2-design.md)):

- The Cloud Scheduler job `drive-poll-<env>` starts the Job in mode
  `forward-all`. That queues one `forward` run per bootstrap-completed
  account and drains the queue in the same execution. The job kept its old
  `drive-poll` name because renaming it would recreate it.
- Each run asks the Drive Activity API for everything under the account's
  Drive root in `(drive_forward_cursor_at, now]`, re-reading the last 2
  minutes (`OVERLAP_MS`) to absorb ingestion lag. It asks for 500
  activities per page (a size hint: a page can hold more, fewer or none)
  and follows `nextPageToken` until none is returned.
- Every changed file is scanned once, in one batch dated by the run (the
  run's UTC date), however many days it changed on. The scan proposes;
  review applies.
- Edit stats (`drive_edit_stats`): one row per (file, editor) holding the
  count for the whole window, dated by the run. A retry replaces its own
  rows.
- The cursor moves to the run's end time only after the scan and the edit
  stats are written. A failed run leaves it where it was, so the retry
  reads the whole window again.
- Reviewers are notified at the end of each run that changed something.

### Cadence

The schedule has two owners, one after the other:

1. **Terraform sets the initial value.** GUB `terraform/drive_poll.tf`
   creates the job from `drive_poll_initial_schedule` and
   `drive_poll_time_zone` (`terraform/variables.tf`).
2. **gub-admin owns it afterwards.** The job's `schedule` and `paused`
   are in `lifecycle.ignore_changes`, so a later `terraform apply` never
   resets them. Change the cadence in gub-admin → Data Sources → Google
   Drive → Poll scheduler (every 1, 2, 6 or 12 hours, daily at 7am ET, or
   weekly on Mondays at 7am ET), and pause or resume it there.

| Environment | Initial schedule (terraform) | Live | Notes |
|---|---|---|---|
| dev | `0 7 * * *`, America/New_York: the variable default (`environments/dev.tfvars` does not override it) | Daily at 07:00 New York (11:00 UTC in summer time, 12:00 in winter), enabled; checked 2026-10-22 | Stays daily: a weekly window would skew the test data. |
| staging, prod | No tfvars file yet, so the same default applies when they are created | Not deployed | Choose daily or weekly when the environment is set up; read the next section before choosing weekly. |

### Before switching an environment to weekly

No part of the run is built around 24 hours: the window is whatever lies
between the cursor and now, and nothing caps files, events or proposals. A
7-day window should run end to end, but no weekly run has been tried yet.
What changes, on one dev account: the daily column covers the 27 of 30
daily runs (2026-09-22 to 2026-10-21) that found changes, and the weekly
column sums 7 consecutive runs. The weekly figures are upper bounds,
because a file changed on several days is scanned once in a weekly window.

| | Daily run | Weekly run |
|---|---|---|
| Activity events | median ~200, max 420 (about 1 page) | median ~1,000, max ~1,500 (about 2–3 pages) |
| Changed files scanned | median 18, max 66 | up to ~150 |
| Run time | 6–18 min | up to about 40–60 min (the task timeout is 24 h) |
| Observations per account in one distillation call | median 30, max 134 | up to ~180 at the median, ~280 at most |

- **Distillation is the risk.** Stage 3 sends every observation of an
  account or campaign to the model in one call. In those 30 daily runs,
  3 distillations failed: two hit rate limits, and one answer was cut off
  on a 96-observation account batch (a 134-observation batch succeeded in
  another run). Weekly batches would be about 2–6 times larger, and a weekly
  run sends many more model calls at once. A failed distillation either
  loses that entity's proposals for the window, or, where failed
  distillations hold the cursor, fails the run; a failure caused by the
  batch size then repeats on every retry. Split large batches, or try one
  weekly window on a test account, before any environment runs weekly.
- **A failed window can cost a week.** The queue retries a failed run (3
  attempts; where retries run inside the same execution, about 1 and 2
  minutes apart). If every attempt fails, or the process dies (for example
  out of memory), the window waits for the next scheduled execution: under
  a weekly cadence a week later, and the window has grown by another week.
- **Alerts.** If the stalled-run alert in GUB terraform
  (`drive_forward_run_stalled`, switched by
  `drive_forward_stall_alert_enabled`) is enabled for the environment, it
  expects a completed forward run about every 25 hours, so under a weekly
  cadence it stays open six days a week: turn it off there. An alert on a
  log-based metric cannot look back further than 25 hours, so a weekly
  check needs another signal.
- **Edit stats.** A week of edits is dated by the run day. Totals per
  editor stay right, but a per-day view shows the whole week on that day.
- **Review.** Reviewers get one notification per run, so one per week for
  the whole week's proposals (about 55 on the dev account). Proposals
  expire after `DRIVE_PROPOSAL_TTL_DAYS` (14), that is after two weekly runs.
- **Freshness.** What the scan writes itself is refreshed once a week:
  piece status texts and, where the scan records file snapshots, the Drive
  file-name index. Account and campaign status texts follow the review:
  they change when a reviewer approves a proposal.

To switch, pick "Weekly, Mondays at 7am ET" in the Poll scheduler and save;
to switch back, pick "Daily at 7am ET". The first run after switching back
covers everything since the last weekly run.

---

## Re-bootstrapping an account

If structure changes meaningfully, content drifts, or operators want a
fresh pass:

```bash
cd ~/Documents/WORK/.../gub-drive-sync
npm run clear -- --account-id <uuid>
```

This is a COMPLETE per-account nuke — `clearAccountComplete`
(src/drive/clear-account.ts), the same code the `clear-account` Cloud
Run mode runs. The account row itself survives (folder pointer +
business fields kept); everything else Drive-sync goes:

- `status_markdown` + `status_sensitive_markdown`
- `drive_bootstrap_cursor`
- `drive_bootstrap_completed_at`
- `drive_last_synced_at`
- `drive_activity_page_token`
- `drive_structure_classification`
- `drive_bootstrap_files`
- `drive_last_run_at`
- All child campaign rows + their `campaign_changes` audit rows
- All `account_changes` audit rows
- All `drive_change_proposals` for this account
- All `drive_scan_logs` for this account
- All `drive_file_snapshots` for this account
- All `drive_sync_runs` queue rows for this account
- All `access_grants` — account-scoped AND campaign-scoped
- Account-scoped `audit_log` entries (succeeds in dev, where the
  append-only triggers are dropped; in prod the triggers reject the
  delete and the whole transaction rolls back)

⚠ **Manually-entered campaign rows are also deleted**, along with their
access grants and audit-log entries. There is no partial scope to pluck
campaigns out of — the wipe is one all-or-nothing transaction. If the
operator wants to preserve campaigns, export/audit them before running.

After clearing, click **Backfill** in gub-admin. Bootstrap runs again
from scratch.

---

## Monitoring

### gub-admin UI

The Data Sources → Google Drive page surfaces:

- **Accounts table**: name, drive folder, last run timestamp, current
  bootstrap cursor, live status badge (pending/running), Backfill/Sync
  button.
- **Recent sync runs**: last 10 runs with mode, status, files processed,
  one-line summary tail, ✕ cancel button on pending/running rows.
- **Job trigger likely failed** banner: appears if the oldest `pending`
  row is > 2 min old without going to `running`. Means IAM, missing Job,
  or local dev without GCP creds.

### Cloud Run logs

Filter by Job name to see live engine output:

```
resource.type="cloud_run_job"
resource.labels.job_name="gub-drive-sync-dev"
```

Useful sub-filters:

```bash
# Per-phase narration
textPayload =~ "Gathering folders|Classifying|Discover files|Scan:|Extracting|Synthesized|Backfill done"

# Heap usage every 30s
textPayload =~ "\\[mem\\]"

# Cache hits / misses
textPayload =~ "Structure cache|Files cache"

# Errors
severity >= ERROR
```

### Phase summary block

Every chunk prints a phase-timing block at the end of the engine log.
Survives the 40-line `tailLogSummary` clip and lands in the
`log_summary` column visible in the gub-admin Recent runs table.

Example:

```
═══ Phase timing (this scan) ═══════════════════════════════════
  Synthesize (per-entity LLM)   8m 12s   ████████████░░░  47%
  Interpret file (per-file LLM) 4m 30s   ██████░░░░░░░░░  26%
  Files cache (read)            0m  1s   ░░░░░░░░░░░░░░░   0%
  Structure cache (read)        0m  1s   ░░░░░░░░░░░░░░░   0%
  Distill (per-entity LLM)      1m 45s   ██░░░░░░░░░░░░░  10%
  Extract text (per-file)       0m 50s   █░░░░░░░░░░░░░░   5%
  DB writes (persistTarget)     0m 18s   ░░░░░░░░░░░░░░░   2%
  ────────────────────────────────────────
  Instrumented total           17m 35s
  Wall-clock total             17m 41s  (un-instrumented: 6s)
```

Use it to diagnose where time is going. If `Synthesize` dominates,
heavy entity day. If `Structure cache` shows MINUTES instead of seconds,
the cache isn't being read (chunk #1 of a chain or cache invalidated).

---

## Troubleshooting

### "Bootstrap stuck — chunk runs but cursor doesn't advance"

Check the log for `persist_cursor` errors. The engine now propagates
persist failures (v2 design) — a failed cursor write fails the whole
chunk. If you see "duplicate key" or constraint errors, there may be
schema drift.

```sql
SELECT
  id,
  status,
  started_at,
  last_heartbeat_at,
  error_message
FROM drive_sync_runs
WHERE account_id = '<uuid>' AND status IN ('pending','running','failed')
ORDER BY requested_at DESC
LIMIT 5;
```

### "Row is stuck in `running` and not progressing"

OOM or SIGKILL likely. The container died mid-run; the row's
`last_heartbeat_at` stops updating.

Recovery options:
- **Wait for stale-recovery**: 15 min after the last heartbeat, the
  next Job invocation's `reclaimStaleRunning` resets the row to
  `pending`.
- **Force-cancel via UI**: ✕ button on the row in Recent runs. Marks it
  `failed` immediately so a new Backfill can queue.

Then re-trigger.

### "OOM — Container terminated on signal 9"

Memory limit reached. Dev runs at 2Gi (`--memory` in `.github/workflows/deploy.yml`;
the staging and prod references in `cloudbuild/` still say 1Gi). Check:
- Was the day-bucket extra heavy? (Many edited files with large PDFs.)
- Is the `[mem]` watcher showing rss climbing? Identify which phase.
- Which file was in memory? Each download of at least `DOWNLOAD_HEAVY_BYTES`
  (50 MiB) logs `[drive.memory] large file in memory` (`fileId`, `bytes`,
  `metadataBytes`, `rssBytes`, `heapUsedBytes`, ...) right after the transfer;
  the last one before the kill names it. `bytes` far above `metadataBytes`
  means the listing was stale and the file was reserved as a small one.
- The end of every run summary shows `Peak memory: RSS ...` (the process
  high-water mark, so it also covers earlier queue rows of the same execution;
  also logged as `[drive.memory] run peak`).
- Lower `DOWNLOAD_INFLIGHT_BYTES` / `DOWNLOAD_HEAVY_BYTES`, or bump `--memory`
  in `.github/workflows/deploy.yml`, and redeploy.

### "Same file processed twice across chunks"

Shouldn't happen with the modifiedTime-bucket model — a file appears in
exactly ONE day-bucket (its modifiedTime day). If it's happening:
- Are file metadata (modifiedTime) changing mid-chain? Activity bots
  touching the Drive externally can do this.
- Is `groupFilesByDate` returning duplicate dates? (Bug; check.)

The bootstrap cache snapshots files at chunk #1; subsequent chunks
read the same cached list. As long as the cache is intact, file ordering
is stable across chunks.

### "Cache HIT but classification looks wrong"

Possible drift between when the cache was written and current state.
For bootstrap, we trust the cache (no fingerprint re-check). To force
re-classification, clear the cache column:

```sql
UPDATE accounts
SET
  drive_structure_classification = NULL,
  drive_bootstrap_files = NULL
WHERE id = '<uuid>';
```

Next chunk will rebuild both. (Or use `npm run clear` for a full reset.)

### "HTTP 403 userRateLimitExceeded"

Hit Drive API's per-user rate limit. The `driveLimiter` in
`src/drive/client.ts` paces calls at 4/sec with retry-on-rate-limit-
error (exponential backoff: 2s → 4s → 8s → 16s → 30s).

If 403s still leak through, the bot user has external Drive traffic
competing for the per-user quota (e.g., the bot's logged into a real
Google session somewhere). Mitigate by reducing concurrency or rotating
the bot to a dedicated session.

### "Synthesis takes forever on heavy days"

Synth is the per-entity LLM call (~1-3 min on Gemini 2.5 Pro). With
`SYNTH_CONCURRENCY=8`, 16 entities → ~5 min wall-clock. If it's worse,
bump `SYNTH_CONCURRENCY` env var (max safe ~12 before hitting Gemini
RPM caps or DB pool).

### "GUB migration deploys before gub-drive-sync"

Order: GUB first (schema), then gub-drive-sync (engine reading new
schema), then gub-admin (UI). If gub-drive-sync deploys before GUB's
migration runs, runtime queries fail with "column does not exist."

Cloud Build triggers are independent — there's no enforced order. If
schema-breaking changes ship, push GUB first and watch its build go
green before pushing the others.

---

## Pre-rebuild data wipe

Before a major schema change like v2, run the nuke script. It clears
backfill-generated data but preserves the org structure (accounts,
staff, etc.).

```bash
cd ~/Documents/WORK/.../gub-drive-sync
psql "$DATABASE_URL" -f scripts/nuke-before-v2.sql
```

This wipes:
- `account_changes` and `campaign_changes` written by drive sync
- `drive_change_proposals`
- `drive_scan_logs`
- `drive_backfill_requests` (rows; the table itself is renamed by the
  migration to `drive_sync_runs`)
- Status markdowns on accounts and campaigns
- Drive sync state columns on accounts

Optional (commented out — review before uncommenting):
- Delete auto-created campaign rows from drive sync.

The nuke is idempotent — safe to re-run.

---

## Local dev

### Running gub-drive-sync engine

```bash
cd ~/Documents/WORK/.../gub-drive-sync

# Drain pending rows (one chunk at a time)
npm run backfill-pending

# Run a single chunk directly, bypassing the queue
npm run backfill -- --account-id <uuid>

# Dry-run a single chunk (no DB writes)
npm run backfill -- --account-id <uuid> --dryrun

# Resolve structure only (no extraction)
npm run backfill -- --account-id <uuid> --structure

# Clear an account's drive-sync data
npm run clear -- --account-id <uuid>

# Run the diagnostic probes
npm run probe-activity        -- --account-id <uuid>
npm run probe-edited-files    -- --account-id <uuid>
npm run probe-file-history    -- --account-id <uuid>
npm run probe-permission-test -- --file-id <fileId>
npm run probe-revision-content -- --file-id <fileId>
```

### Running gub-admin

```bash
cd ~/Documents/WORK/.../gub-admin
npm run dev
```

Open http://localhost:3000 → Data Sources → Google Drive.

### Local Drive testing flow

1. Make sure local DB is migrated:
   ```bash
   cd ~/Documents/WORK/.../gcp-universal-backend
   npx prisma migrate deploy
   ```
2. Bot user is shared on the target Drive folder.
3. From gub-admin UI: click Backfill on an account.
4. The Admin API trigger will fail locally (no GCP creds for Cloud Run
   Job). The row sits `pending`.
5. From a second terminal: run `npm run backfill-pending` in
   gub-drive-sync. Drains one chunk. Exit.
6. Repeat step 5 until bootstrap completes.

For faster iteration: loop it.

```bash
for i in {1..500}; do
  npm run backfill-pending || break
done
```

The loop exits when no pending row is found, so when bootstrap finishes
it stops naturally.

---

## Deployment

### Cloud Build triggers

- **gcp-universal-backend**: builds + deploys GUB service. Migration runs
  via `prisma migrate deploy` as part of the deploy step.
- **gub-drive-sync**: builds the engine image, deploys to Cloud Run
  Jobs via `gcloud run jobs deploy`. No service traffic; next
  `jobs:run` uses the new image.
- **gub-admin**: builds + deploys gub-admin Cloud Run service.

For schema-breaking changes, push GUB first and confirm migration
applied before pushing the others.

### Cloud Run Job config

`.github/workflows/deploy.yml` (the dev `FLAGS`):

```yaml
- --tasks=1
- --parallelism=1
- --max-retries=0
- --task-timeout=86400s
- --memory=2Gi
- --cpu=1
- --service-account=sa-gub-drive-sync-dev@...
- --set-cloudsql-instances=...
- --set-env-vars=NODE_ENV,GCP_PROJECT_ID,GCP_REGION,DRIVE_SYNC_JOB_NAME,...
- --set-secrets=DATABASE_URL,GUB_BOT_OAUTH_CLIENT_ID,...
```

### IAM bindings

The gub-admin service account needs `roles/run.developer` on the
gub-drive-sync Job (to fire it via Admin API):

```bash
gcloud run jobs add-iam-policy-binding gub-drive-sync-dev \
  --region=us-central1 \
  --member=serviceAccount:gub-admin-dev@... \
  --role=roles/run.developer
```

The gub-drive-sync runtime SA needs Drive scopes (carried by the bot
OAuth refresh token, not the runtime SA) plus Cloud SQL Client
(`roles/cloudsql.client`) for DB access.

---

## Secrets

Stored in Secret Manager, mounted as env vars in the Job:

| Secret | Variable | Source |
|---|---|---|
| `gub-drive-sync-db-url-dev` | `DATABASE_URL` | Postgres connection string for `gub_dev` |
| `gub-drive-sync-bot-oauth-client-id-dev` | `GUB_BOT_OAUTH_CLIENT_ID` | Bot OAuth web client ID |
| `gub-drive-sync-bot-oauth-client-secret-dev` | `GUB_BOT_OAUTH_CLIENT_SECRET` | Bot OAuth web client secret |
| `gub-drive-sync-gemini-api-key-dev` | `GEMINI_API_KEY` | Gemini API key |
| `gub-drive-sync-mailgun-api-key-dev` | `MAILGUN_API_KEY` | Mailgun key (notification path) |

To rotate any secret: `gcloud secrets versions add <name> --data-file=-`,
then re-deploy (Cloud Run picks up `:latest`).

---

## Bot OAuth

The bot user (`<drive-bot>@<workspace-domain>`) holds an OAuth refresh
token in the `bot_credentials` table. Operations:

- **Initial grant / re-grant**: gub-admin Settings → Bot Credentials.
  Use this to add scopes or rotate.
- **Add a new scope**: add it to `gub-admin/src/lib/bot-oauth.ts`'s
  `BOT_SCOPES.drive` array AND the GCP OAuth consent screen (Data
  Access). Then re-grant the bot through gub-admin UI.
- **Share the bot on a new Drive folder**: from the Drive UI, add
  `<drive-bot>@<workspace-domain>` as Viewer (Commenter for stricter
  visibility).

---

## Known gotchas

- **`/healthz` 404s**: Cloud Run's frontend reserves the lowercase
  `/healthz` path. Use `/health/live`.
- **Job overrides replace CMD entirely**: the Dockerfile uses
  `ENTRYPOINT ["node", "dist/src/main.js"]` so `containerOverrides.args
  = ['backfill-pending']` works as the mode arg without losing the
  entry path.
- **Cloud Build with serviceAccount**: when a custom SA is set on the
  build trigger, the build YAML must also explicitly declare
  `serviceAccount:` at top-level or the logs-config validation fails.
- **Drive Activity API is a separate API**: requires `drive.activity.
  readonly` scope (on the bot) AND the Drive Activity API to be enabled
  in the GCP project (one-click via console).
- **revisions.list returns 0 for Workspace files at Viewer role**: even
  though the Drive UI shows version history. Editor+ role unlocks
  revisions.list. We don't need this — we don't try to fetch historical
  content.
- **Connection pool of 3 by default**: Prisma's default
  (`num_physical_cpus * 2 + 1`) is 3 on Cloud Run --cpu=1. We override
  to 10 via `connection_limit=10` in `prisma.ts`.

---

## Related docs

- [`drive-sync.md`](./drive-sync.md) — architecture
- [`status-markdown-plan.md`](./status-markdown-plan.md) — status_markdown
  content design
