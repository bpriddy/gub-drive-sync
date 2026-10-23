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
| index catch-up (`refresh-snapshots`, `src/drive/snapshot-refresh.ts`) | once, by an operator with `--confirm`: one row per file whose latest row no longer matches a Drive listing; a listing only, nothing is extracted | NULL |

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
| `sync_run_id` | **v1 only**: the `sync_runs` row of the full sync. It references `sync_runs`, a different table from the `drive_sync_runs` queue the v2 drivers run under, so **v2 writers and the catch-up leave it NULL**. Stamping a queue id here fails the foreign key (Postgres 23503) — the first scan-core writer did exactly that and wrote nothing. NULL is necessary, not sufficient, for "written by v2": a v1 row also has it NULL if its run row was later deleted, and the catch-up's rows are NULL too (they have `was_extracted = false`). |
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
Its form depends on `SKIP_UNCHANGED_CONTENT`:

- `off` (the default), and every v1 row: an md5 of the full extracted text.
- `on` (v2 rows): a versioned hash from `src/scan/content-gate.ts`, of what
  the model calls after the gate depend on. Both forms include the gate's
  epoch (`GATE_EPOCH`), the name, the path, the zone and whether the ideas
  tier runs for the account.
  - `v2:` + sha256 of the prompt-visible text (the first
    `GEMINI_MAX_INPUT_CHARS` characters and whether the text was cut). When
    the ideas tier runs, it also covers a digest of the full text of a cut
    file, because idea extraction reads all of it. Used for Google-native
    files, shortcuts, and downloads that came without a content marker.
  - `bin:` + sha256 of Drive's content marker (`md5Checksum`, else
    `headRevisionId`, else `version`) and `GEMINI_MAX_INPUT_CHARS`, for
    downloaded files. Known before the download.

  Left out on purpose: the modified time and editor (they change on every
  edit), the "N chars omitted" count, the known-campaigns vocabulary and the
  entity states. The prompt preset, the model and the extractor version are
  left out too: after such a change, bump `GATE_EPOCH` to re-interpret every
  file once.

  An md5 never equals either form, so turning the flag on re-interprets
  each file once.

  An extracted row whose idea extraction or merge failed carries no hash, so
  the gate retries that file on its next event.

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
| `index_refresh` | A listing-only row: the file was seen in a Drive listing and nothing was extracted. | the catch-up |
| `trashed` | The file is in the Drive trash (forward runs fetch files by id, which also returns trashed ones); nothing was read. | v2, `SKIP_UNCHANGED_CONTENT=on` |
| `content_unchanged` | The content hash matched the hash on the file's newest relevant row in the account (see "The unchanged-content gate" below), so interpret and idea extraction did not run. The older extracted row stays the file's source. | v2 forward runs, `SKIP_UNCHANGED_CONTENT=on` |

## The unchanged-content gate

With `SKIP_UNCHANGED_CONTENT=on`, the forward run compares each file's
content hash with ONE row: the file's newest row in this account, once rows
that record no reading are looked through (`content_unchanged`, `trashed`,
`index_refresh`).

The gate skips the file only when that row meets all three conditions:
- it is an extracted row with a hash;
- it was written at or before the cutoff;
- its hash matches.

The cutoff is the account's last completed `drive_sync_runs` row, less 60 s
for clock skew. Rows after the cutoff may come from an attempt whose later
stages failed: H2's window-commit gate retries the window, and the first
attempt has already written extracted rows. A newer `extract_error`,
`restricted` or other skip row vetoes the skip, and the gate never falls
back to an older row.

A file on the restricted worklist is always read: the read is the probe that
resolves its row.

The gate fails open. With no completed run yet, an unreadable cutoff or a
failed lookup, every file is interpreted, as with the flag off.

Known gap: a row written by an attempt that never committed counts as
committed once any LATER run of the account completes. One case is a
manual bootstrap that completes between a failed forward attempt and its
retry. Closing it needs each row's run id (`drive_sync_run_id`, which the
index work adds): then only rows of completed runs would count.

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

## Catching up the index

A forward run indexes only the files it processes, so a file created, renamed
or moved while nothing wrote the index stays unfindable, or findable under its
old name, until it is edited again. `refresh-snapshots` closes that gap once,
from a Drive listing: no extraction and no model call.

```
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=refresh-snapshots,--account-id,<account uuid>            # dry-run
gcloud run jobs execute gub-drive-sync-dev --region=us-central1 \
  --args=refresh-snapshots,--account-id,<account uuid>,--confirm  # write
```

`--account-id` is optional (absent: every account with a Drive folder); an id
that matches nothing, a flag it does not know and a missing value are errors.

Run it when no forward or bootstrap run is pending or running for the account,
so outside the daily forward run. A scan-core row written between the
catch-up's lookup and its insert would otherwise end up behind the catch-up's
row, an older reading of the same file, until the file changes again.

1. **Dry-run first.** Without `--confirm` it lists, compares and writes
   nothing. The output is counts only — never a file name, path or id: one
   line per account (its id, the files listed, which listing was used, the rows
   it would write by reason, the legacy counters below) and a total.
2. **`--confirm`** writes those rows, one INSERT each: `was_extracted = false`,
   `skip_reason = 'index_refresh'`, `sync_run_id` NULL, `path` rooted at the
   account like a forward row's, and `campaign_id` the campaign (or piece)
   folder nearest above the file. A row that fails is counted and reported with
   the WARN described above (`source = refresh`); the other rows are still
   written and the run fails after its summary. A re-run writes nothing: its
   listing now matches the rows.
3. **Refresh GUB's token-frequency view afterwards.** File search weights a
   query's words by a materialized view over the latest row per file. It is
   refreshed out of band, with the migration role, by GUB's
   `scripts/refresh-file-search-df.ts`; until then new names rank, at worst,
   a little noisier.

**What is compared.** The file's latest row against the listing, first match
wins; no match means no row.

| Reason | The latest row differs from the listing in |
|---|---|
| `unindexed` | there is no row at all |
| `renamed` | `name` |
| `moved` | `path` |
| `modified` | `modified_time` |
| `mime_changed` | `mime_type` |

**The listing.** A root inside a shared drive (the drive root included) is
listed flat, about one `files.list` call per 1000 items of the drive and not one
per folder; a root inside a drive that refuses the flat listing falls back to
the walk (the drive root itself does not: a walk could not read it either), and
a My Drive root always walks. Both root the path at the account's name, the label
the forward run uses, so a catch-up row and a forward row of one file carry the
same path. Files below an unreadable subfolder, or below the depth cap, are not
listed; the output counts both.

**Legacy rows and moves.** The v1 sync scanned an account from its root and then
each campaign folder again, rooted at the campaign's *name* (see `path`
above). A file in a campaign folder therefore has two rows per v1 run, the
campaign-rooted one written last, so it is the file's latest row, and no
listing's path starts like it. Compared as it is, every such file would count as
moved. For a latest row that has a `sync_run_id` and a `campaign_id` the
catch-up compares the listing's path with the account-rooted row *the same run*
wrote for the file instead. The same path means the file has not moved; a
campaign folder that moved since v1 still counts, because the listing then
differs from the run's account-rooted row as well. Two counters report it:

- `legacyNormalized`: files compared that way;
- `legacyUnresolved`: files whose run left no account-rooted row. They are
  compared as they are, so a `moved` among them can be a false one; the cost is
  one extra index row each.

A campaign deleted since v1 nulls `campaign_id` on its rows, which hides them
from this rule: they are compared as they are, with the same cost.

**What else reads the rows.** `_sources` and the cited-file lookup read
`was_extracted = true` rows only, so they are unchanged. The v1 delta rule
(`checkDelta`) ignores `index_refresh` rows: a listing says nothing about which
version was last extracted, so a file with a newer listing-only row is still
extracted when v1 scans it.

## Readers

The readers outside this repo are all in GUB:

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

None of the GUB readers filters on `skip_reason`, so `trashed` and
`content_unchanged` rows need no reader change there.
- A `content_unchanged` file keeps its older extracted row in `_sources` and
  in cited-file resolution: the content is the same.
- That row's `scanned_at` no longer moves with each touch, so such a file
  stops climbing `_sources`, which is ordered newest-first.
- File-name search reads the new row's current name and path.

In this repo:
- v1's delta rule (`checkDelta`) reads the latest row except `index_refresh`
  ones. It counts `content_unchanged` and `trashed` rows, which record the
  current modified time. A v1 scan would then treat a restored trashed file as
  unchanged. Only v1 is affected.
- The catch-up (`snapshot-refresh.ts`) reads the latest row's name, path and
  modified time, which a `content_unchanged` row records as current.

A trashed file (flag on) is skipped unread, so an edit made just before it
was trashed is not interpreted.
