# gub-drive-sync

A **Cloud Run Job** (not a service) that runs the machine-driven Google
Drive sync for GUB. It hosts the six modes that used to live as HTTP
endpoints in `gcp-universal-backend`:

| Mode | What it does | Who triggers it |
|---|---|---|
| `poll` | Incremental `changes.list` delta; dispatches a full sync only when in-scope changes exist | Cloud Scheduler (`drive-poll-<env>`) |
| `run-full-sync` | Bootstrap / "Sync now"; full discover + scan; captures fresh page token at end | gub-admin Sync button + operator gcloud |
| `continue` | Self-trigger continuation when a chunked sync hits its 50-min wall-clock budget | This Job itself (Admin API → its own Job, fresh execution) |
| `cron` | Legacy alias for `run-full-sync` | (kept for compat) |
| `notify` | On-demand reviewer email fan-out | Operator gcloud (rarely) |
| `sweep-expired` | Flip pending proposals past `expires_at` to `state='expired'` | Cron / operator |

The reviewer-facing magic-link endpoints (`GET /review/:token`,
`POST /review/:token/decide`) stay in `gcp-universal-backend` for now —
those are browser-reachable surfaces that the Cloud Run Job model can't
host. The eventual home for them is a standalone non-IAP token-auth
service (pattern B in the standalone-service topology), but that's a
separate workstream.

## Why a Cloud Run Job

- **Zero public surface.** A Job has no URL, no port, no HTTP listener.
  Nothing to scan or DDoS. The only way it starts is the Cloud Run Admin
  API (`jobs:run`), which is IAM-gated.
- **No IAP fight.** gub-admin sits behind Cloud Run integrated IAP. A
  machine trigger (Cloud Scheduler, a self-trigger callback) can't pass
  IAP — same wall gub-bot-oauth and gub-research-worker hit. A Job
  sidesteps it entirely: there's no door for IAP to guard.
- **Long-running.** Full Drive syncs can take 50-min chunks; the runner
  pauses and self-triggers a fresh execution at chunk boundaries. A
  Cloud Run **service** request maxes at 60 min; a Job's task-timeout
  ceiling is 24 h. Plenty of margin.
- **Sensitive code isolated.** The Drive bot's OAuth client secret, the
  Gemini key, and Mailgun creds live only in this Job's Secret Manager
  mount. Neither GUB nor gub-admin sees them post-migration.

## Architecture

```
TRIGGERS (no Cloud Scheduler clock for run-full-sync; an explicit cause
          fires each Job execution):

  Cloud Scheduler `drive-poll-<env>`  ──→  jobs:run, args=["poll"]
                                           │
                                           │ if in-scope changes:
                                           ▼
                                       jobs:run, args=["run-full-sync"]
                                       (kicked off inside the same Job
                                        process via the runner)

  gub-admin "Sync now" button       ──→   jobs:run, args=["run-full-sync"]

  Operator gcloud                   ──→   jobs:run --args=...

THE RUNNER (one process per execution):

  main.ts (dispatch on argv[2])
    │
    ├── poll               → reaper + runIncrementalPoll
    ├── run-full-sync      → reaper + startFullSync (chunked, in-process)
    ├── continue           → reaper + continuePausedSync
    ├── cron               → alias for run-full-sync
    ├── notify             → notifyReviewers
    └── sweep-expired      → sweepExpiredProposals

  CHUNKED FULL SYNC:
    50-min wall-clock budget per chunk. When budget trips:
      1. Persist sync_run.status='paused' + chunk_phase + chunk_index
      2. jobs:run on THIS job, args=["continue", "--sync-run-id", X]
      3. Exit cleanly. A fresh execution picks up from the checkpoint.
```

The self-trigger replaces the old HTTP self-POST. The runtime SA has
`roles/run.developer` scoped to its own job (set by `setup-gcp.sh`
after first deploy). Concurrent executions are safe by design: the
runner's concurrency guard in `startFullSync()` refuses to start a new
sync while one is `running` or `paused`.

## What stays in `gcp-universal-backend`

| Thing | Why |
|---|---|
| `drive.review.ts` + `GET/POST /review/:token` endpoints | Email-link reviewer surface; reviewers don't have IAP sessions, so this needs a browser-reachable host. Pattern-B home is deferred — stays in GUB for the first pass. |
| `drive.schema.ts` (the writable-field allowlists + validators) | Source of truth lives in GUB so `drive.review.ts` can use it. **Mirrored into this repo** — see the loud banner at the top of `src/drive/schema.ts`. |
| `drive_*` migrations (`drive_change_proposals`, `drive_file_snapshots`, `drive_scan_logs`, `drive_sync_state`, `sync_runs` extensions) | Schema lives in GUB; this Job reads + writes via its own Prisma client (full mirror of `prisma/schema.prisma`, same pattern gub-admin + gub-research-worker use). |

## What this Job needs

See `.env.example`. Required at runtime:
- `DATABASE_URL` — shared GUB DB
- `GUB_BOT_OAUTH_CLIENT_ID` + `GUB_BOT_OAUTH_CLIENT_SECRET` — the same
  bot-OAuth client that gub-admin uses for the consent flow. At runtime
  we mint short-lived access tokens from the `drive` bot's refresh
  token (`bot_credentials` row, written by gub-admin's Settings → Sync
  Credentials → Authorize on `drive`).
- `GCP_PROJECT_ID` + `GCP_REGION` + `DRIVE_SYNC_JOB_NAME` — so the
  runner can self-trigger continuation executions.

Optional (degrade gracefully):
- `GEMINI_API_KEY` — unset falls back to a mock driver that returns
  schema-shaped empty responses. Pipeline still runs end-to-end in dev.
- `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` + `MAIL_FROM_ADDRESS` — unset
  falls back to console-driver dry-run.
- `DRIVE_ROOT_FOLDER_ID` — when unset, new-entity discovery is a no-op.
  Per-entity scans still work.

## Local dev

```bash
cp .env.example .env       # fill DATABASE_URL + GUB_BOT_OAUTH_*
npm install
npm run dev poll           # or run-full-sync / continue / etc.
```

`npm run dev` runs `src/main.ts` via `tsx`. The first positional arg is
the mode; subsequent flags are mode-specific (`--sync-run-id=<uuid>` for
`continue`).

## CI / CD

Same convention as the other GUB repos. Single Cloud Build trigger on
`main` → `cloudbuild/dev.yaml`, deploying the Cloud Run Job
`gub-drive-sync-dev`. `staging.yaml` / `prod.yaml` are committed for
when prod exists; their triggers are added then. Unlike a Service, a
Job has **no traffic/promotion step** — `jobs deploy` updates the
definition and the next `jobs:run` uses the new image.

### First-time GCP bootstrap

```bash
./scripts/setup-gcp.sh <project-id> us-central1
```

Idempotent. Creates: the Artifact Registry repo; per-env runtime SAs
(`sa-gub-drive-sync-{dev,staging,prod}`) with cloudsql.client +
secretmanager.secretAccessor + log/trace/metric writer; five Secret
Manager placeholders per env (db url, bot OAuth client id, bot OAuth
client secret, Gemini key, Mailgun key); Cloud Build SA permissions;
the `main` trigger; and (after the Job exists) three job-scoped
bindings:

| Member | Role | Reason |
|---|---|---|
| `sa-gub-admin-<env>` | `roles/run.developer` | Sync button fires the Job |
| `sa-gub-drive-sync-<env>` | `roles/run.developer` | Runner self-triggers `continue` |
| `sa-gcp-universal-backend-<env>` | `roles/run.invoker` | Cloud Scheduler `drive-poll-<env>` fires the Job (OIDC) |

The script prints the remaining manual steps:

1. Connect the GitHub repo to Cloud Build (browser, one-time).
2. Populate the five secrets per env.
3. Push to `main` → first deploy creates the Job.
4. **Re-run `setup-gcp.sh`** — the three job-scoped bindings can't be
   created until the Job exists.
5. Apply the updated `gcp-universal-backend/terraform/drive_poll.tf` so
   the Cloud Scheduler `drive-poll-<env>` job posts to the Admin API
   instead of GUB. (Done as a separate `terraform apply` — coordinate
   with the operator.)
6. Update gub-admin env: add `DRIVE_SYNC_JOB_NAME=gub-drive-sync-<env>`
   so its Sync button fires the right Job. See gub-admin/cloudbuild/
   <env>.yaml.

## Triggering manually

```bash
# Operator laptop (ADC) — fire one mode:
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=poll

gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=run-full-sync

gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=continue,--sync-run-id,<uuid>

# Sweep expired proposals:
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=sweep-expired
```

### Merge duplicate campaigns (`merge-campaign-dupes`)

One-shot cleanup that detects duplicate Campaign rows for one account
(year-drift / suffix-noise / separator-drift name variants — e.g. "Truck
Season 2025" vs "TRUCK SEASON CAMPAIGN") via a single Gemini call, then
merges each cluster into one canonical row. The detector is
split-by-default and only proposes clusters at confidence ≥ 0.8.

**Destructive and irreversible** — variant rows are deleted, their FK
references (campaign_changes, drive_file_snapshots, drive_scan_logs,
drive_change_proposals, access_grants) redirected to the canonical, and
the canonical's `status_markdown` re-synthesized from the merged set. Each
merge is recorded in `audit_log` (action `campaign_merged`) but there is no
rollback table.

```bash
# DRY-RUN — detect + log the clusters that WOULD merge. No writes, no LLM
# synthesis. Read the logged `outcome.clusters` to review before applying.
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=merge-campaign-dupes,--account-name,chevy

# APPLY — same detection, then merge every cluster ≥ 0.8 confidence.
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=merge-campaign-dupes,--account-name,chevy,--confirm

# Optional: raise the floor (only merge ≥ 0.9), or target by id.
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=merge-campaign-dupes,--account-id,<uuid>,--min-confidence,0.9,--confirm
```

Detection uses deterministic round-robin windowed clustering. Sorting is too
brittle (it assumes duplicates share a prefix) and random shuffles can't
*guarantee* coverage. Instead each "schedule" splits the roster into W/2-blocks
and round-robins them (every pair of blocks shares a window exactly once), run
`--vote-threshold` times — so every campaign pair is examined ≥ threshold times,
at the combinatorial floor of ~`(N-1)/(W-1)` rounds. Pairs the LLM co-groups in
≥ threshold windows are unioned; the list collapses to canonicals and the
schedule repeats on the shrunken set until no new merge. Tuning knobs (defaults:
window 40, vote-threshold 2) are CLI-overridable so they can be tuned without a
redeploy:

```bash
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=merge-campaign-dupes,--account-name,chevy,--window,40,--vote-threshold,2
```

Review the result (the `outcome` object is logged as structured JSON):

```bash
gcloud logging read \
  'resource.labels.service_name="gub-drive-sync-dev" AND jsonPayload.msg="gub-drive-sync complete"' \
  --project=os-test-491819 --limit=1 --format='value(jsonPayload.outcome)'
```

Local equivalent (hits whatever `DATABASE_URL` points at):

```bash
npm run merge-campaign-dupes -- --account-name chevy            # dry-run
npm run merge-campaign-dupes -- --account-name chevy --confirm  # apply
```

### Complete per-account nuke (`clear-account`)

Clean-slate an account so a re-bootstrap starts blank. The account row
survives (its `drive_folder_id` + business fields are kept); **everything
else Drive-sync is wiped** in one transaction — child campaigns, all their
changes/proposals/scan-logs/snapshots, the `drive_sync_runs` queue,
`access_grants` (account + campaign), Chevy `audit_log` entries, and every
account sync/cache column (`drive_bootstrap_cursor`,
`drive_structure_classification`, `drive_bootstrap_files`, …). This exists
because the old per-account `clear` left bootstrap-cache + snapshot residue
that silently skipped re-classification/re-extraction.

**Destructive & irreversible.** No `--confirm` = dry-run (counts only).

```bash
# DRY-RUN — counts what would be deleted/reset. No writes.
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=clear-account,--account-name,chevy

# APPLY — the full nuke.
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=clear-account,--account-name,chevy,--confirm
```

**audit_log — dev vs prod:** the whole nuke is one transaction. In dev the
audit-log immutability triggers are dropped, so the `audit_log` purge
succeeds. When prod re-enables those triggers, that delete raises and the
entire transaction rolls back — production stays strict, enforced by the DB
(not by `NODE_ENV`, which is `production` on the deployed dev job). Local
equivalent: `npm run clear -- --account-id <uuid>` (same shared code path).

## Prod implementation checklist

When a prod environment exists:

1. `./scripts/setup-gcp.sh <prod-project> us-central1` (idempotent).
2. Connect the repo to Cloud Build if new project.
3. Populate secrets per the script's printed instructions.
4. Push `main`; first deploy creates `gub-drive-sync-prod`.
5. Re-run `setup-gcp.sh` to bind the three job-scoped roles.
6. Apply terraform to retarget `drive-poll-prod` Cloud Scheduler at the
   Admin API.
7. Confirm gub-admin's prod env carries `GCP_PROJECT_ID` / `GCP_REGION`
   / `DRIVE_SYNC_JOB_NAME=gub-drive-sync-prod`.
8. Smoke test: hit gub-admin's Sync button on the Drive data source,
   watch the Job execution in Cloud Run job history, confirm a fresh
   `sync_runs` row lands with `status='success'` (or `paused` then a
   second execution running `continue` if the run chunked).

## Known temporary debt

**`drive.schema.ts` is mirrored, not shared.** This repo's
`src/drive/schema.ts` is a duplicate of
`gcp-universal-backend/src/modules/integrations/google-drive/drive.schema.ts`.
Both versions must stay in lockstep — they encode the same writable-field
allowlists, Zod validators, current-state shapers, and `FieldWriteSpec`
table. Adding a new writable field requires editing both files plus a
migration.

This is intentional for the first pass:

- Same pattern as `prisma/schema.prisma` (mirrored across GUB,
  gub-admin, gub-research-worker, and this repo).
- Pulling into a shared `@gub/drive-schema` npm package adds release
  ceremony pre-launch that buys little.
- The allowlist changes are rare (the casting tool is past the
  what-fields-do-we-track phase).

A loud banner at the top of `src/drive/schema.ts` calls this out, and so
does `gcp-universal-backend/src/modules/integrations/google-drive/drive.schema.ts`.
Future consolidation into a shared package is captured as a follow-up.
