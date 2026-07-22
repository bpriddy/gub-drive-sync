# Drive Sync — Architecture Reference

`gub-drive-sync` reads Drive content for an account, runs LLM extraction +
synthesis, and writes the result to the account's and campaigns'
`status_markdown` columns plus an audit log.

This doc describes the system as it stands. For operations (running it,
troubleshooting), see [`drive-sync-operations.md`](./drive-sync-operations.md).

---

## Modes

Drive sync has two modes. Both share the same extraction → distillation →
synthesis pipeline; they differ in how files are discovered.

### Bootstrap

One-time per account. Walks **every file** currently in the account's
Drive root, processes each file once on the calendar day of its
**`modifiedTime`**, and stamps observations with that day.

- Triggered by clicking **Backfill** in gub-admin's Data Sources page.
- Chunked across Cloud Run Job executions — each chunk processes one
  active day. A continuation chain self-triggers until the cursor catches
  up to today.
- Sets `accounts.drive_bootstrap_completed_at` when complete. After that,
  forward sync takes over.

**Why `modifiedTime`?** A file that was edited multiple times shows up
once, on the date of its most recent edit. Synthesis sees observations in
temporal order — newer entries naturally supersede older ones in the
status_markdown.

**Why one day per chunk?** Cursor advancement is unambiguous, persist
failures don't lose multi-day work, the chain mechanic is the same as
forward sync (mode dispatch in the queue). Locked.

### Forward sync

Daily (scheduled). Polls the Drive Activity API for changes since the
last `pageToken`, re-processes the changed files, stamps observations
with the actual edit timestamps from the activity events.

- Triggered by Cloud Scheduler (terraform); operator can also click
  **Sync** in gub-admin to fire one immediately.
- Same chunking + continuation pattern; the changeset window is bounded
  by `pageToken` rather than calendar day.
- Status: **stub today.** Forward mode runs through the same engine but
  doesn't yet poll Activity API — it walks `modifiedTime` buckets like
  bootstrap. Real Activity-driven forward sync is the next milestone.
- **When building it, start from [edit-stats-decision.md](edit-stats-decision.md)**
  — the per-editor edit-event stats (decided 2026-07-20) ride this build:
  the same Activity event stream feeds both file re-processing and the
  `drive_edit_stats` tally. Scope is already granted and probe-verified.

---

## Data flow

For ONE chunk (one Cloud Run Job execution):

```
                          ┌──────────────────────────────┐
                          │ Queue: claim row             │
                          │ (SKIP-LOCKED in transaction) │
                          └──────────────┬───────────────┘
                                         │
                                         ▼
                          ┌──────────────────────────────┐
                          │ Engine: setup                │
                          │ - loadEntity                 │
                          │ - read structure cache       │  ← persisted from chunk #1
                          │ - read files cache           │  ← persisted from chunk #1
                          └──────────────┬───────────────┘
                                         │
                          ┌──────────────▼───────────────┐
                          │ Cache MISS path (chunk #1):  │
                          │ - gather folders (Drive API) │ ~33s
                          │ - LLM classify folders       │ ~1m 45s
                          │ - discover files (Drive)     │ ~3 min
                          │ - bucket by modifiedTime     │
                          │ - persist both caches        │
                          └──────────────────────────────┘
                                         │
                          ┌──────────────▼───────────────┐
                          │ Pick this chunk's day        │
                          │ (first activeDate > cursor)  │
                          └──────────────┬───────────────┘
                                         │
                          ┌──────────────▼───────────────────────────┐
                          │ Per-file loop (the day's bucket):        │
                          │   - extract content (Drive download +    │
                          │     parse, OR Workspace API for native)  │
                          │   - interpret (Gemini Pro per-file LLM)  │
                          │   - route observations into entity       │
                          │     buckets (account vs each campaign)   │
                          └──────────────┬───────────────────────────┘
                                         │
                          ┌──────────────▼───────────────────────────┐
                          │ Per-entity worker pool                   │
                          │ (concurrency = SYNTH_CONCURRENCY = 8)    │
                          │   for each touched entity:               │
                          │     - distill (Gemini, observations →    │
                          │       field_changes + notes)             │
                          │     - validate field_changes against     │
                          │       schema constraints                 │
                          │     - synthesize (Gemini Pro, merge w/   │
                          │       prior status_markdown)             │
                          │     - persist (DB writes)                │
                          └──────────────┬───────────────────────────┘
                                         │
                          ┌──────────────▼───────────────────────────┐
                          │ Persist cursor (account's date pointer)  │
                          │ If this was the last activeDate:         │
                          │   - set bootstrap_completed_at           │
                          │   - NULL drive_bootstrap_files (~10MB)   │
                          └──────────────┬───────────────────────────┘
                                         │
                          ┌──────────────▼───────────────────────────┐
                          │ Queue: if allRemaining + not complete:   │
                          │   - write continuation row               │
                          │   - call Cloud Run Admin API to fire     │
                          │     a fresh Job execution                │
                          │ Otherwise: exit                          │
                          └──────────────────────────────────────────┘
```

The chain continues until the cursor reaches today (or no more active
days exist). Each continuation is a fresh Job execution that re-loads
state from the DB, including the cache columns.

---

## Schema

Per the v2 migration (`20260610000000_drive_sync_v2`) and the cache
migration (`20260610100000_drive_bootstrap_cache`).

### `accounts` (drive-sync fields only)

| Column | Type | Purpose |
|---|---|---|
| `drive_folder_id` | TEXT | Root folder of this account's Drive tree |
| `drive_last_run_at` | TIMESTAMPTZ | Wall-clock of the latest sync run (bootstrap or forward) touching this account |
| `drive_bootstrap_cursor` | DATE | Latest completed modifiedTime day in the bootstrap walk. NULL = bootstrap hasn't started. |
| `drive_bootstrap_completed_at` | TIMESTAMPTZ | Set ONCE when bootstrap catches the cursor up to today. After this, forward sync owns the account. |
| `drive_last_synced_at` | TIMESTAMPTZ | Latest completed forward sync. NULL until first forward chunk. |
| `drive_activity_page_token` | TEXT | Activity API pageToken for the next forward run. NULL before first forward chunk. |
| `drive_structure_classification` | JSONB | Cached `{ fingerprint, entityMap, folders, ... }`. Built by bootstrap chunk #1; reused by chunks 2..N. SURVIVES bootstrap completion; forward sync re-uses with hash invalidation. |
| `drive_bootstrap_files` | JSONB | Cached `{ files, activeDates }`. Built by bootstrap chunk #1; reused by chunks 2..N. NULLed on completion (~10MB payload, no value after). |
| `status_markdown` | TEXT | Synthesized human-readable summary (general bullets) |
| `status_sensitive_markdown` | TEXT | Synthesized summary, sensitive tier (per D29) |

### `campaigns` (drive-sync fields only)

| Column | Type | Purpose |
|---|---|---|
| `drive_folder_id` | TEXT | Optional: the campaign's specific subfolder, used for structure classification |
| `drive_folder_path` | TEXT | Human-readable breadcrumb from account root |
| `drive_last_run_at` | TIMESTAMPTZ | Wall-clock of the latest run that updated this campaign's status_markdown |
| `status_markdown` | TEXT | Per-campaign synthesized summary |
| `status_sensitive_markdown` | TEXT | Per-campaign sensitive tier |

### `drive_sync_runs`

Queue of bootstrap + forward runs.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `account_id` | UUID FK | |
| `mode` | TEXT | `'bootstrap'` \| `'forward'` (CHECK constraint enforced) |
| `status` | TEXT | `'pending'` \| `'running'` \| `'completed'` \| `'failed'` |
| `requested_by` | UUID FK staff | Human staff for operator clicks; system-staff UUID for continuation rows |
| `requested_at` | TIMESTAMPTZ | When the row was written |
| `started_at` | TIMESTAMPTZ | When claim happened (status → running) |
| `completed_at` | TIMESTAMPTZ | Terminal time |
| `last_heartbeat_at` | TIMESTAMPTZ | Liveness pulse; engine updates every 5 min while running |
| `attempts` | INT | SKIP-LOCKED claim increments; terminal failure at MAX_ATTEMPTS=3 |
| `next_attempt_at` | TIMESTAMPTZ | Earliest re-claim after transient failure (exponential backoff) |
| `all_remaining` | BOOL | True → after this chunk, queue another in the same mode if work remains |
| `files_processed` | INT | Files processed in this chunk |
| `activity_page_token_in` | TEXT | Forward only: token handed to this chunk |
| `activity_page_token_out` | TEXT | Forward only: token at chunk end |
| `error_message` | TEXT | Terminal-failure detail |
| `log_summary` | TEXT | Last ~40 lines / 2KB of engine stdout |

Indexes:
- `drive_sync_runs_pickup_idx` on `(status, next_attempt_at, requested_at)` — claim
- `drive_sync_runs_history_idx` on `(account_id, requested_at DESC)` — UI
- `drive_sync_runs_heartbeat_idx` on `(status, last_heartbeat_at)` — partial — stale-recovery scan

### `*_changes`

Append-only audit log per entity property (the change-tracking pattern
shared with the rest of the org schema). Drive-sync writes are attributed
to the system-staff UUID `dcd5d8e3-0000-4000-a000-000000000001`.

---

## Bootstrap chain cache

The 5-minute prelude (gather folders, LLM classify, discover files) is
identical for every chunk in a bootstrap chain — the structure doesn't
change while the chain runs. Two JSONB columns on `accounts` cache the
results so chunks 2..N skip the prelude.

### `drive_structure_classification`

```jsonc
{
  "fingerprint": "sha256-hex-of-canonical-folder-list",
  "entityMap": { /* classifyFolders output */ },
  "folders": [ /* gatherFolders output */ ]
}
```

- Built by bootstrap chunk #1, written via `persistStructureCache`.
- Reused by chunks 2..N (currently trusted; for forward sync we'll
  re-gather + re-hash + compare).
- Survives bootstrap completion; forward sync inherits it.

### `drive_bootstrap_files`

```jsonc
{
  "files": [ /* TraversedFile[] — full file metadata */ ],
  "activeDates": [ /* DayBucket[] — pre-bucketed by modifiedTime */ ]
}
```

- Built by bootstrap chunk #1, written via `persistBootstrapFilesCache`.
- Reused by chunks 2..N as-is.
- NULLed on bootstrap completion (no value after; forward sync uses
  Activity API).

### Fingerprint

`structureFingerprint(folders)` returns `sha256(canonical(folders))`:

1. Map each folder to `{ id, name, parentId }`.
2. Sort by id (deterministic ordering).
3. JSON-stringify.
4. SHA-256.

Same folder set → same fingerprint regardless of Drive API return order.
Any add/rename/move/delete of a folder → different fingerprint → cache
miss → re-classify.

---

## LLM pipeline

Three LLM steps per chunk. All use Gemini (configurable per-preset in
`prompt_presets` table).

### Per-file (extract → interpret)

For every file in the day's bucket:

1. **Extract** (`src/drive/extract.ts`): pull content from Drive.
   - Google-native (Docs/Slides/Sheets): per-type Workspace API. Returns
     structured-but-flat text.
   - Binary (PDF/DOCX/PPTX/text/*): `downloadFileBuffer` + per-type
     parser. Size cap (`DRIVE_MAX_FILE_SIZE_BYTES`, default 300MB).
   - `predictExtractionSkip` is the metadata-only skip check
     `extractText` runs first — unsupported mimes and oversize files
     short-circuit without any I/O.

2. **Interpret** (`src/drive/interpret.ts`): per-file LLM call via the
   preset `drive.file_extraction.v1`. Inputs: extracted text + account/
   campaign context + known-campaign vocabulary. Outputs:
   - `account` observations (about the brand at large)
   - `campaign` observations (each tagged with `entity_campaign_name`
     for routing)

### Routing

`routeCampaignObs` (in `scripts/backfill.ts`) places each campaign
observation into:
- **`existing:<campaignId>`** — name matched a known campaign, or the
  file's folder is owned by an existing campaign
- **`new:<folderId>`** — folder is structure-discovered new candidate
- **`phantom:<normalizedName>`** — LLM emitted a name with no match
  (rare, often noise)

### Per-entity (distill → synthesize)

After all files in the chunk are interpreted, the engine processes each
touched entity (account + each campaign with observations) through:

1. **Distill** (preset `drive.distillation.v1`): observation bucket →
   structured `{ field_changes, notes }`. Field changes get validated
   against the schema (writable fields, allowed enum values, no-op
   detection) before being layered onto the entity's rendering state.

2. **Synthesize** (`status_synthesis_v1` prompt in
   `src/drive/status-synthesis.ts`): merges new observations with the
   entity's prior `status_markdown` (and prior sensitive-tier markdown).
   Outputs quad-output:
   - general context bullets
   - general transient bullets (with `[expires:]` markers)
   - sensitive context bullets
   - sensitive transient bullets

The per-entity loop runs in parallel via `runWithConcurrency`
(`SYNTH_CONCURRENCY=8`). Each entity is fully independent — different
`status_markdown` rows, no shared state.

---

## Continuation chain

Chunking across Cloud Run Job executions is the Pattern-A standalone
sync pattern (`project_standalone_job_pattern.md`). Each chunk:

1. Claims a `pending` row via `SELECT ... FOR UPDATE SKIP LOCKED`.
2. Stamps `last_heartbeat_at = now()` at claim time.
3. Spawns a 5-min heartbeat ticker for liveness.
4. Runs the engine for one day (bootstrap) / one Activity window (forward).
5. On success:
   - Updates `status = 'completed'`, `files_processed`, etc.
   - If `all_remaining = true` AND not yet caught up: writes a fresh
     `pending` row with the same mode, then calls Cloud Run Admin API to
     fire a new Job execution.
6. On transient failure (3 attempts max): re-pending with exponential
   backoff.
7. On terminal failure: `status = 'failed'` with error message.

### Crash recovery

`reclaimStaleRunning` runs at the top of every Job invocation. Rows whose
`last_heartbeat_at` is older than `STALE_RUNNING_MS = 15min` (3× the 5-min
heartbeat interval) get reset to `pending`. Legacy rows without a
heartbeat fall back to `started_at`.

Cancelling a stuck row from the gub-admin UI (the **✕** button)
short-circuits this — operator forces the row to `failed` immediately so
a new Backfill click can queue without waiting for stale-recovery.

### Concurrency safety

The Cloud Run Job has `--parallelism=1`, so only one Job execution per
account at a time. The drain loop within an execution breaks after a
continuation fires (`continuationFired = true`) to avoid racing the
cold-started successor for the row it just wrote.

---

## File map

### `gub-drive-sync` (engine)

```
scripts/
  backfill.ts                   The engine. Args, Result, parseArgs, main(),
                                runBackfill, runBackfillInner. Contains
                                Args interface, structure-cache helpers,
                                processBatch, runStructureOnly, and the
                                day-walking loop.
  clear.ts                      Operator utility: nuke a specific account
                                (or all campaigns) from drive-sync data.
  nuke-before-v2.sql            One-time pre-migration data wipe.
  probe-*.ts                    Diagnostic probes (Activity API,
                                revisions, file history, permission
                                gating). Useful for investigation; not
                                wired into runtime.

src/drive/
  client.ts                     Drive v3 API client. Includes:
                                - driveLimiter (4 req/s, promise-chained)
                                - downloadFileBuffer
                                - retry-on-403-rate-limit
                                Bot OAuth via buildBotOAuthClient.
  extract.ts                    extractText() — mime-dispatched content
                                extraction. predictExtractionSkip() —
                                metadata-only skip check extractText
                                runs first.
  interpret.ts                  Per-file LLM call. Uses preset
                                drive.file_extraction.v1.
  structure.ts                  gatherFolders, classifyFolders,
                                buildAttributor. FolderNode + EntityMap
                                types.
  status-synthesis.ts           Per-entity synthesis prompt assembly
                                (status_synthesis_v1), quad-output
                                parsing, at-a-glance rendering.
  backfill-queue.ts             Queue logic: claim, drain, continuation,
                                heartbeat ticker, scheduleContinuation
                                via Cloud Run Admin API.
  orchestrator.ts               Older sync orchestrator (Drive Sync v1
                                pre-Pattern-A days). Updates drive_last_run_at.
  traversal.ts                  gatherFilesAuto, traverseFolder. Used by
                                the bootstrap engine for file discovery.

src/ai/                         LLM client + preset service.
src/workspace/                  Bot OAuth credential management.
src/prisma.ts                   Prisma client singleton w/ connection_limit
                                =10 override.
src/config.ts                   Env-driven config. Includes
                                SYNTH_CONCURRENCY, GEMINI_MAX_INPUT_CHARS,
                                DRIVE_MAX_FILE_SIZE_BYTES.
src/main.ts                     Job entry point. Modes:
                                'poll' | 'run-full-sync' | 'continue' |
                                'cron' | 'notify' | 'backfill-pending' |
                                'sweep-expired'. Dispatch in main().
src/heal/                       Drive-aware staff/account healing (older).

prisma/schema.prisma            Mirrored schema (drive_sync_runs +
                                accounts/campaigns fields).

cloudbuild/
  dev.yaml                      Cloud Build trigger for dev environment.
                                --memory=2Gi --cpu=1. Heartbeat watcher
                                in engine relies on this headroom.

docs/
  drive-sync.md                 This file.
  drive-sync-operations.md      Runbook.
  status-markdown-plan.md       status_markdown content design (D-decisions).
```

### `gub-admin` (UI + operator API)

```
src/app/data-sources/google_drive/
  page.tsx                      Two tables:
                                  - Accounts (per-account row, Backfill button)
                                  - Recent sync runs (with mode badge)
  account-backfill-row.tsx      Per-account interactive row (inline edit
                                of drive_folder_id, Backfill click).
  request-row.tsx               Per-run row in the runs table (mode +
                                file count + cancel ✕).

src/app/api/data-sources/google_drive/
  backfill/route.ts             POST: write drive_sync_run with mode=bootstrap,
                                fire Cloud Run Job via Admin API.
  backfill/[id]/route.ts        DELETE: force-cancel a pending or
                                running run.

prisma/schema.prisma            Mirror (DriveSyncRun + account columns).
```

### `gcp-universal-backend` (GUB)

```
prisma/
  schema.prisma                 Source-of-truth schema.
  migrations/
    20260610000000_drive_sync_v2/         v2 architecture (DriveSyncRun)
    20260610100000_drive_bootstrap_cache/ Bootstrap cache columns
    [earlier drive-sync migrations]
```

GUB itself has no drive-sync runtime code; it's the schema owner.

---

## Configuration knobs

Environment variables consumed at runtime by gub-drive-sync. Defined in
`src/config.ts` with Zod validation.

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection. `connection_limit=10` appended in prisma.ts. |
| `GUB_BOT_OAUTH_CLIENT_ID` / `_SECRET` | — | Bot user OAuth client (web) for Drive API. |
| `GEMINI_API_KEY` | — | Gemini API key. |
| `GEMINI_MAX_INPUT_CHARS` | 40000 | Per-file LLM input truncation cap. |
| `DRIVE_MAX_FILE_SIZE_BYTES` | 314572800 (300MB) | Binary download cap. Google-native bypasses. |
| `SYNTH_CONCURRENCY` | 8 | Per-entity worker pool size for distill+synth. |
| `GCP_PROJECT_ID` / `GCP_REGION` / `DRIVE_SYNC_JOB_NAME` | — | Required for `scheduleContinuation` to fire fresh Job executions. |

Cloud Run Job resource limits (terraform / cloudbuild yaml):

| Setting | Value | Why |
|---|---|---|
| `--memory` | 2Gi | OOM'd at 1Gi on Chevy's large day-buckets. The `[mem]` heap watcher logs every 30s for diagnostics. |
| `--cpu` | 1 | I/O-bound (Drive + Gemini). 1 CPU is enough. |
| `--task-timeout` | 86400s (24h) | Conservative cap; individual chunks aim for ~5-45 min. |
| `--parallelism` | 1 | One execution per Job at a time. Continuation chains chunks; in-execution synth is parallel via worker pool. |
| `--max-retries` | 0 | Engine + queue handle retries via the `attempts` column. Job-level retry would double up. |

---

## Prompts

Three editable presets in the `prompt_presets` table:

| key | Used by | What it does |
|---|---|---|
| `drive.file_extraction.v1` | Per-file LLM (`interpretFile`) | Extracts account + campaign observations from one file's content |
| `drive.distillation.v1` | Per-entity distill | Observation bucket → field_changes + notes |
| (inline in `status-synthesis.ts`) | Per-entity synth | Quad-output: general + sensitive × context + transient |

Editing prompts:
- File-extraction + distillation: managed via the `prompt_presets` table.
  gub-admin's Prompts page renders + edits these.
- Synthesis: hardcoded in `status-synthesis.ts`. Code change required.

Schema constants used by prompts:
- `ACCOUNT_WRITABLE_FIELDS`, `CAMPAIGN_WRITABLE_FIELDS` from
  `src/drive/schema.ts` — what fields a `field_change` is allowed to
  target.
- `validateProposedValue` — enum/format validation per field.
- `EMPTY_CAMPAIGN_STATE` — placeholder for new-candidate synthesis.

---

## What we don't do (and why)

### Historical content reconstruction

We do NOT attempt to fetch what a file looked like on some past date.
Google's Drive API doesn't expose historical revision content for
Workspace files (Docs/Sheets/Slides) at any scope or role we've tested.
For binary files, Drive auto-purges revisions after 30 days unless
`keep_forever` is set (which isn't supported for Workspace files at
all, and we don't enable for binaries).

The bootstrap model accepts current content stamped with the file's
`modifiedTime` and lets synthesis order observations chronologically.
Supersession works naturally; we never claim "X was true at T."

### Per-revision processing of edited files

Even when revisions exist, we don't iterate them. Synthesis sees each
file ONCE per chunk, with its current content. The cost of historical
fidelity isn't worth the LLM volume increase.

### Drive Activity API for bootstrap

Activity API is the right primitive for forward sync (efficient delta
detection). It's not right for bootstrap because:

- Files moved INTO the current drive from elsewhere don't have CREATE
  events visible in the current drive's activity log.
- The activity-only model would require reconstructing the file list
  from event history, which `files.list` returns directly with metadata.

So bootstrap uses `files.list`; forward sync uses Activity API.

### Pinning Workspace revisions for future fidelity

`keep_forever = true` is not supported on Workspace file revisions per
Google's API. Even if it were, Google's auto-merge consolidates micro-
edits over time. So we can't build a "preserve every edit going forward"
mechanism even if we wanted one.

---

## Related docs

- [`drive-sync-operations.md`](./drive-sync-operations.md) — runbook
- [`status-markdown-plan.md`](./status-markdown-plan.md) — status_markdown
  content design (D-decisions, transient rules, sensitive tier)
