# Drive file index — `drive_file_snapshots`

What the table is, who writes it, what its columns mean and how a failed write
surfaces. Read the `was_extracted` section before building on that flag: it
means something different in the v1 full sync and in the v2 scan core.

For the surrounding architecture see [`drive-sync.md`](./drive-sync.md); for
running and monitoring the sync see
[`drive-sync-operations.md`](./drive-sync-operations.md).

---

## What it is

`drive_file_snapshots` is the **append-only history** of every file the sync
has processed, and it doubles as the **Drive file-name index** that GUB reads.
One row is written per processed file per run. A writer only ever INSERTs: it
never updates or deletes a row, and a re-run of the same window simply adds
another row for the same file. The newest row per `file_id` (`scanned_at DESC`)
is the file's current state; older rows are its history.

The exceptions are operator modes, not writers of the sync:

- `merge-campaign-dupes` re-points `campaign_id` from a merged-away campaign
  to the canonical one.
- `clear-account` deletes an account's rows.

The database also nulls `account_id`, `campaign_id` and `sync_run_id` when the
row they reference is deleted (`ON DELETE SET NULL`).

## Writers

| Writer | When it writes | `sync_run_id` |
|---|---|---|
| v1 full sync (`scanFolder`, `src/drive/sync.ts`) | an account scan, then one scan per campaign folder; a row for every file seen, including `delta_unchanged` ones | the `sync_runs` row of that sync |
| v2 scan core (`processBatch`, `src/scan/process-batch.ts`) | every forward run and every bootstrap chunk, one row per file of the batch, in `apply` and `propose` mode; **never in `dryrun`** | NULL |

The v2 writer sits in the scan core's serial apply chain, after the file's
outcome is applied, so the rows come out in file order whatever the worker
pool does. The row is telemetry, not dossier content: it is written whether
or not the file produced observations, and review never gates it.

## Columns that matter

| Column | Meaning |
|---|---|
| `file_id` | Drive file id; the key readers group by. |
| `name`, `mime_type`, `modified_time`, `modified_by`, `size_bytes` | The file as the run saw it. |
| `path` | ` / `-separated breadcrumb. **v1** roots it at the name of the entity the scan was for: an account scan at the account, a campaign scan at the campaign. So a file inside a campaign folder can have an account-rooted row and a campaign-rooted row from the same v1 run. **v2** roots every path at the account (queue-driven runs are always account-scoped). |
| `account_id` | The account the run belongs to. |
| `campaign_id` | **v2**: the file's *folder attribution* — the campaign whose folder the file sits in, NULL for account-level files — not whatever campaign an LLM tag routed its observations to. **v1**: set by campaign scans, NULL on account scans. |
| `sync_run_id` | **v1 only**: the `sync_runs` row of the full sync. It references `sync_runs`, a different table from the `drive_sync_runs` queue the v2 drivers run under, so **v2 writers leave it NULL**. Stamping a queue id here fails the foreign key (Postgres 23503) — the first scan-core writer did exactly that and wrote nothing. NULL is necessary, not sufficient, for "written by v2": a v1 row also has it NULL if its run row was later deleted. |
| `was_extracted`, `content_hash`, `skip_reason` | See below. |
| `scanned_at` | When the row was written (database clock). Readers order by it. |

## `was_extracted`: v1 and v2 differ

| | v1 (`scanFolder`) | v2 (scan core) |
|---|---|---|
| `true` means | the text was **extracted** | the text was extracted **and the per-file interpret call returned** |
| An interpret failure | the row stays `true` | the row is `false`, `skip_reason = 'extract_error'` |
| An extraction failure | `false`, `extract_error` | `false`, `extract_error` |

In v1 the interpret step runs in an `onExtract` callback right after
extraction; the callback logs its own failure and carries on, and the snapshot
row is written afterwards. A rate-limited interpret therefore left the row
`true`, and because the delta rule compares `modified_time`, the file was
never interpreted again until it changed.

In v2 the worker extracts and interprets in one step, and the outcome is `ok`
only if both succeeded. What happens to the file afterwards — routing its
observations, the ideas tier, distillation, synthesis — never changes the row;
failures there are the runs' own gates (the forward cursor does not advance,
the bootstrap day is not committed).

`content_hash` is set exactly on the extracted rows (`was_extracted = true`).

A consumer that needs "interpreted" must read **v2 rows only** (they leave
`sync_run_id` NULL — see the caveat above) or accept v1's weaker meaning.

## `skip_reason`

NULL on an extracted row. Otherwise:

| `skip_reason` | Meaning | Written by |
|---|---|---|
| `empty`, `too_large`, `unsupported_mime`, `shortcut_unverified_size` | The extractor's own reason for skipping the file. | v1, v2 |
| `extract_error` | Extraction threw — or, in v2, the interpret call did. | v1, v2 |
| `restricted` | Drive answered 403: the file is visible in listings, its content is not readable by the sync bot. | v2 |
| `delta_unchanged` | Unchanged since the last v1 scan; extraction was skipped. | v1 |
| `skipped` | A v2 skip outcome that carried no reason (defensive; not expected). | v2 |

## A write that fails

A row that cannot be written is **never swallowed**. The scan core:

1. counts it (`BatchOutcome.snapshotWriteFailures`) and logs one WARN per row:
   `[drive.snapshot] write failed`, with `fileId`, `accountId`, `source`
   (`scan`), `code` (the Prisma error code, or the error's class name) and
   `constraint` (when Prisma names one). Ids and codes only — never the
   error's message, because Prisma messages can carry the row's values;
2. finishes the batch, so the other files' rows are still written;
3. fails the run when the count exceeds `SNAPSHOT_WRITE_FAILURE_LIMIT`
   (default `0`: any failed row fails the run). A forward run does not advance
   the account cursor; a bootstrap day is not committed. The queue retries
   the row with backoff and, after its last attempt, marks it failed where
   operators see it. History is append-only, so every failed attempt leaves
   one more row per file of the window — up to the queue's attempts, and again
   on later runs while the cursor is held. Readers take the latest.

Raising `SNAPSHOT_WRITE_FAILURE_LIMIT` is a stop-gap while a database or
schema problem is fixed: the files over the limit stay stale in the index
until they change again.

The WARN's message text is a contract: the platform's Terraform defines a
log-based metric on it and an alert policy on that metric, so reword it only
together with that definition.

## Readers

All of them are in GUB:

- **File-name search** takes the **latest row per
  file** — whatever its kind — for `name`, `path`, `mime_type`, `modified_time`
  and the scope columns. A trigram index on `name` serves the match; a
  materialized view of token frequencies, refreshed out of band, weights it.
- **The `_sources` lists** of an account or campaign take the **latest row with
  `was_extracted = true`** per file, newest first, capped.
- **Cited-file resolution** (file id to name and type) takes the newest row
  with `was_extracted = true` for that file id, whoever owns it.

So a file that has never had an extracted row (every run skipped it or
failed on it) is searchable by name but appears in no `_sources` list, and a
file whose newest row is a skip still shows up there through its older
extracted row.
