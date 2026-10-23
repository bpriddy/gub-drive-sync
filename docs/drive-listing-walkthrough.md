# Drive listing walkthrough (H3, #65)

Status: walkthrough written before the change and reviewed; §7 and §8 record what was built.
Base: `origin/main` `a17f00a`.
Scope: how every entry point reaches `files.list` today, what a flat listing for roots inside a
shared drive changes, and the diff for #65. The catch-up in #66 is the third consumer.

## 1. Entry points and call graph

Three drivers matter for #65. The v1 paths (`poll`, `run-full-sync`, `extract-ideas`) are listed
last for completeness; only the page size change touches them.

```
forward-all ─► backfill-queue.processOne ─► runForward (src/forward/run.ts)
  ├─ queryActivityWindow                       (Activity API, not files.list)
  ├─ resolveAccountStructure(trustCache=false) (src/backfill/structure-stage.ts)
  │    └─ gatherFolders(root)                  (src/drive/structure.ts)   ← EVERY busy run
  │         ├─ probeFolder(root)               files.get id,driveId,mimeType
  │         ├─ root IS the drive  → listAllFoldersInDrive(driveId) → buildTreeFromFlat(root)
  │         └─ otherwise          → walkFoldersRecursive → listSubfolders(folder) per folder
  └─ getFileMetadata(id) per changed file      files.get FILE_FIELDS (not files.list)

backfill-pending ─► processOne ─► runBackfill (src/backfill/run.ts)   (bootstrap chain)
  ├─ resolveAccountStructure(trustCache=true)  → gatherFolders only on a cache miss (chunk 1)
  └─ Discover files, only when accounts.drive_bootstrap_files is NULL (chunk 1)
       ├─ gatherFilesAuto(root)                (src/backfill/discovery.ts)
       │    ├─ probeFolder(root)
       │    ├─ root IS the drive  → listSharedDriveFiles(driveId, orderBy createdTime)
       │    └─ otherwise          → gatherFilesRecursive → traverseFolder → listFolderChildren per folder
       └─ campaign scans: gatherFilesRecursive(piece folder) per piece   (always recursive)

refresh-snapshots (the index catch-up, #66)
  └─ per account: probeFolder(root)
       ├─ inside a shared drive → listSubtreeFiles(root): flat folder + file sweeps  (~35 calls)
       └─ My Drive, or a refused in-drive listing → traverseFolder → listFolderChildren per folder

v1 / other:
  run-full-sync, poll → scanEntity → scanFolder (src/drive/sync.ts) → traverseFolder
  run-full-sync discovery (src/drive/discover.ts) → listFolderChildren (one level, sampling)
  extract-ideas → runIdeaExtraction → traverseFolder; resolveIdeaTarget fallback → gatherFolders
  poll → isInsideFolder → files.get per ancestor
  structure-only CLI → runStructureOnly → gatherFolders
```

Today the flat path is taken only when `probe.isSharedDriveRoot`, i.e. `files.get(root).id === driveId`.
A folder inside a shared drive has `driveId` set but is walked one call per folder, and so is a
My Drive folder (no `driveId`).

## 2. Call sites

All calls set `supportsAllDrives: true`; every `files.list` also sets `includeItemsFromAllDrives: true`.

| Function | corpora | `q` | pageSize | fields | Retry today | Parents / path |
|---|---|---|---|---|---|---|
| `probeFolder` | n/a (`files.get`) | n/a | n/a | `id,driveId,mimeType` | limiter only (rate limit) | n/a |
| `listFolderChildren` | default (`user`) | `'<f>' in parents and trashed = false` | 200 | `FILE_FIELDS` | limiter only | `parents` as returned; the caller builds the path |
| `listSubfolders` | default | `… in parents and mimeType = folder and trashed = false` | 200 | `id,name` | limiter only | none returned; the walk knows the parent it listed |
| `listAllFoldersInDrive` | `drive` + `driveId` | `trashed = false and mimeType = folder` | 200 | `id,name,parents` | limiter only | `parentId = parents[0]` |
| `listSharedDriveFiles` | `drive` + `driveId` | `trashed = false and mimeType != folder` | 200 | `FILE_FIELDS` | limiter only | `parents` as returned; **`path = name`** (no breadcrumb) |
| `getFileMetadata` | n/a (`files.get`) | n/a | n/a | `FILE_FIELDS` | `withTransientRetry` ∘ limiter; 404 → null | forward: `parents[0]` → `folderPathById` |

`FILE_FIELDS` = `id,name,mimeType,parents,modifiedTime,createdTime,size,lastModifyingUser(emailAddress,displayName),shortcutDetails(targetId,targetMimeType)`.

**Retry path.** Every call goes through `driveLimiter.run`: one call in flight, at least 250 ms
apart, and up to 5 attempts on a rate-limit 403/429 (2 s → 30 s). A 5xx or a dropped socket on a
`files.list` page is **not** retried on `main`; only `getFileMetadata` wraps `withTransientRetry`.
What a failure does depends on the caller:

- recursive walks: an error on the root throws; an error on a subfolder is swallowed and that branch
  is skipped (`walkFoldersRecursive`: debug log; `traverseFolder`: `onFolderError`, which
  `gatherFilesRecursive` counts as "subfolder(s) unreadable");
- flat listings: any page error throws and the whole gather fails.

The open H2 branch (#64) adds a service-level request timeout and jittered rate-limit backoff in the
same file. It does not add transient retry to `files.list`.

**Path derivation.**

- `traverseFolder` and `walkFoldersRecursive`: the path is the walk path,
  `<root label> / <a> / <b> / <name>`. The parent of a `FolderNode` is the folder it was listed
  under, or `null` when that folder is the root.
- `buildTreeFromFlat`: the path is built on the way down from the root by the `parents[0]` pointers,
  in the same format. It is byte-identical to the walk for single-parent trees.
- `listSharedDriveFiles`: `path = name`. The bootstrap of a drive-root account therefore feeds bare
  file names as `file_path` into the per-file interpret prompt.
- Forward: `path = (folderPathById.get(parents[0]) || <account name>) + ' / ' + name`. Attribution
  everywhere uses `parents[0]` (`buildAttributor`); an unknown parent falls back to the account.

## 3. Parent map invariants

The map is rebuilt from a fresh listing on every gather, so nothing stale carries between runs.
Bootstrap chunks 2..N reuse the cached structure and file list by design; #65 does not change that.

1. **One parent per node.** `parentId = parents[0]`. Shared-drive items have exactly one parent, so
   `multi_parent` must stay 0 on the flat path. It is a tripwire, not a feature.
2. **Scope is "reaches the root".** A node is in scope if and only if its parent chain reaches
   `rootId`. A chain that reaches `driveId` first is `out_of_scope`. A chain that hits an id missing
   from the listing (or loops) is an orphan.
3. **Identity with the walk.** For any tree the recursive walk can read, the flat build must return
   the same node set, `path`, `depth` and `parentId`, and therefore the same `structureFingerprint`.
   Otherwise the switch alone forces an LLM re-classify. Only sibling **order** may differ (see R4).
4. **Depth.** Folders are kept to depth 101 (root = 0), as in both walks. Files are kept only when
   their parent is the root or a folder at depth ≤ 100, as `traverseFolder` does. Each folder at
   depth 101 counts once as a depth-cap hit.
5. **Cycle safety.** There is a visited set on every upward and downward walk.
6. **Trash.** `trashed = false` stays in `q`. Per the Drive docs, `trashed` is also true for items
   trashed "from a trashed parent folder", so a trashed folder's descendants drop out of the flat
   listing just as the walk never reaches them.

## 4. Cases: today vs proposed

| Case | Today | Proposed (flat, in-drive root) |
|---|---|---|
| Move inside the subtree | Next gather sees the new place. Folder moves change the fingerprint → re-classify. Forward path uses the fresh map. | Same. The map is fresh per run. |
| Rename | New name. A folder rename rewrites descendant paths and the fingerprint → re-classify. | Same. |
| Move out of the subtree | No signal. The item is absent from the next walk. Forward: if Activity reports it, its parent is not in the map, so it gets path `<account> / name`, is attributed to the account, and is scanned as if inside. | Listing: counted as `out_of_scope`. For an in-drive root that is everything else in the drive, a size figure, not a move signal. Forward (H3-4): changed files whose parent is not in the map are counted and logged; behaviour is otherwise unchanged and there is no tombstone. |
| Orphan (parent not visible) | Walk: unreachable, so never listed. Flat drive root: `buildTreeFromFlat` drops orphan folders silently; `listSharedDriveFiles` keeps orphan files (no subtree filter). | Counted as `orphans`. In-drive: excluded, the same as the walk. Drive-root files: still kept, now counted. |
| Multi-parent (legacy) | Flat: `parents[0]` + visited set. Walks: **no visited set**, so a multi-parent folder's subtree is listed once per parent (duplicate nodes and files). My Drive only. | Flat: `parents[0]`, counted as `multi_parent` (expect 0). My Drive stays recursive and unchanged (H3-7). |
| Depth cap (100) | Walks stop below depth 101 (`onDepthCap`). `buildTreeFromFlat` caps folders the same way. `listSharedDriveFiles` ignores depth. | Same caps as the walk, files included (invariant 4); counted as `depth_cap`. Drive-root files unchanged. |
| Shortcuts | Listed as files with `shortcutTarget`. Folder shortcuts are not descended (mime is not folder) and are not in the folder listings. Targets outside the tree are followed by the extractor. | Same. Shortcuts are non-folder items whose parent is in scope. |
| Trashed | Excluded by `q`; descendants of a trashed folder are unreachable. | Excluded by `q`; descendants carry `trashed = true` (invariant 6). |

## 5. Root shapes in config today

The probe result (`driveId`) is not stored anywhere, so SQL can only split roots by id shape.
Shared-drive (and My Drive) root ids are short and start with `0A`; folder ids are longer. SQL cannot
tell "folder in a shared drive" from "folder in My Drive". Prepared, **not run**, read-only, for the
dev database:

```sql
-- Q1. Configured roots by kind and id shape, with the cached folder count.
WITH roots AS (
  SELECT 'account'::text AS kind, a.drive_folder_id,
         a.drive_bootstrap_completed_at IS NOT NULL AS bootstrapped,
         a.drive_forward_cursor_at > now() - interval '7 days' AS forward_7d,
         CASE WHEN jsonb_typeof(a.drive_structure_classification -> 'folders') = 'array'
              THEN jsonb_array_length(a.drive_structure_classification -> 'folders') END AS cached_folders
    FROM accounts a
   WHERE a.drive_folder_id IS NOT NULL
  UNION ALL
  SELECT 'campaign', c.drive_folder_id, NULL, NULL, NULL
    FROM campaigns c WHERE c.drive_folder_id IS NOT NULL
  UNION ALL
  SELECT 'piece', p.drive_folder_id, NULL, NULL, NULL
    FROM campaign_pieces p WHERE p.drive_folder_id IS NOT NULL
)
SELECT kind,
       CASE WHEN drive_folder_id ~ '^0A[0-9A-Za-z_-]{10,24}$' THEN 'drive_root_shape'
            ELSE 'folder_shape' END                AS id_shape,
       count(*)                                    AS roots,
       count(*) FILTER (WHERE bootstrapped)        AS bootstrapped,
       count(*) FILTER (WHERE forward_7d)          AS forward_active_7d,
       max(cached_folders)                         AS max_cached_folders,
       sum(cached_folders)                         AS sum_cached_folders
  FROM roots
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- Q2. Per account (accounts are what forward and bootstrap scan).
SELECT a.id, a.name,
       CASE WHEN a.drive_folder_id ~ '^0A[0-9A-Za-z_-]{10,24}$' THEN 'drive_root_shape'
            ELSE 'folder_shape' END AS id_shape,
       a.drive_bootstrap_completed_at, a.drive_forward_cursor_at,
       CASE WHEN jsonb_typeof(a.drive_structure_classification -> 'folders') = 'array'
            THEN jsonb_array_length(a.drive_structure_classification -> 'folders') END AS cached_folders
  FROM accounts a
 WHERE a.drive_folder_id IS NOT NULL
 ORDER BY 3, 1;

-- Q3. Bootstrap log tails that kept the probe line ("Folder type: …").
-- log_summary is a 40-line tail and the line is printed early, so expect few or no rows.
SELECT r.account_id, max(r.started_at) AS last_seen,
       substring(r.log_summary from ('Folder type: [^' || chr(10) || ']*')) AS folder_type_line
  FROM drive_sync_runs r
 WHERE r.mode = 'bootstrap' AND r.log_summary LIKE '%Folder type:%'
 GROUP BY 1, 3;
```

Reading the result: a `drive_root_shape` account already took the flat path for its folders and
gains only the page size. A `folder_shape` account is a candidate for the new path. Telling a
folder in a shared drive from a My Drive folder takes one `probeFolder` call per root: $0, but it
reads a live Drive, so it needs a go (`--all --probe-only`, §7).

## 6. Risks

- **R1. `corpora=drive` visibility.** The bot may have access to a folder inside a shared drive
  without being a member of the drive. The docs say `corpora=drive` "queries all items in the
  specified shared drive" but do not say what a non-member gets. Mitigation (H3-1): fall back to
  the recursive walk, with a new log line, on a 404, on a 403 whose reasons name no limit or
  quota, or on a listing that does not contain the root. A partial listing that does contain the
  root is safe, because the walk sees only what the bot can read too.
- **R2. Cost scales with the drive, not the subtree.** The flat cost is `ceil(drive items / 1000)`.
  A small root inside a huge drive can cost more than its walk (`subtree folders + 1`). For folders
  this needs a drive more than 1000× the subtree. For files it is likelier. The worst case is
  bounded by the shared-drive cap of 500,000 items (~500 pages). H3-6.
- **R3. All-or-nothing errors.** One failed page fails the gather, where the walk skipped one
  subfolder. That is arguably safer: a silently partial tree changes the fingerprint and triggers a
  paid re-classify on a wrong map. Mitigation: wrap each page of the new listings in
  `withTransientRetry` (3 attempts). A page token stays valid across retries.
- **R4. Sibling order.** `buildTreeFromFlat` orders siblings by listing order, the walk by per-folder
  listing order. The fingerprint is order-free, so the switch does not force a re-classify. But the
  tree rendered into the classify prompt may list siblings in a different order on the next
  drift-triggered re-classify. Files are re-sorted by `createdTime` (a stable sort) as today, so only
  exact-timestamp ties can reorder.
- **R5. Memory.** An in-drive root lists the whole drive. Mitigation: list folders first (an
  id → {name, parent} map, ~100 B per folder), then filter each file page as it arrives so
  out-of-scope files are never held. For drive-root accounts memory is unchanged.
- **R6. Several accounts in one drive.** Each account lists the whole drive, and `forward-all`
  drains accounts serially. Not addressed here (a per-execution cache keyed by `driveId` would be).
  §5 shows whether it occurs.
- **R7. Merge with H2.** The H2 branch reformats `client.ts` and `structure.ts` and adds a 60 s read
  timeout. The conflicts are mechanical. A 1000-item page should take a few seconds; the measurement
  listing (§7) confirms the margin.
- **R8. Prompt inputs.** For in-drive roots the file `path` must stay byte-identical to the walk's,
  because it is the interpret prompt's `file_path`. The tests pin the flat build against the walk on
  the same fixture.

## 7. As built

One commit per item, after a formatting-only commit (prettier on the four touched files).

1. **Page size.** `LIST_PAGE_SIZE = 1000` in `client.ts` feeds `listFolderChildren`,
   `listSubfolders`, `listAllFoldersInDrive` and `listSharedDriveFiles`. `changes.list` is not a
   `files.list` and keeps 100.
2. **Flat folders for any root in a shared drive.**
   - `buildTreeFromFlat` moves unchanged to the pure module `src/drive/folder-tree.ts`.
   - `gatherFolders` takes the sweep whenever `probe.driveId` is set.
   - A folder inside a drive falls back to `walkFoldersRecursive` when the listing is unavailable
     (`isListingUnavailableError`): a 404, a 403 whose reasons name no limit or quota, or a listing
     without the root. A 403 naming a limit, a 5xx and anything else propagate. For the drive root
     every error propagates, as before.
   - Sweep pages retry transient faults (`withTransientRetry` around the limiter).
3. **Flat files for a folder inside a drive.**
   - `listSubtreeFiles` (`src/drive/subtree.ts`) runs the folder sweep, builds the tree, then calls
     `listDriveFilesFlat(driveId, keep)`.
   - `keep` filters each page as it arrives. A file is kept exactly when `traverseFolder` would
     yield it: `subtreeParentPaths` maps its `parents[0]` to the root or to a subtree folder at
     depth ≤ 100.
   - Paths are the walk's breadcrumbs, byte for byte.
   - The file sweep orders by `createdTime`, which an edit does not change, so files cannot shift
     pages mid-sweep. An id seen twice is kept once. Only exact-`createdTime` ties can order
     differently from the walk.
   - Fields are `FILE_FIELDS` + `version,md5Checksum`, carried as optional `TraversedFile` fields.
   - `gatherFilesAuto` sorts with the walk's own stable `createdTime` sort.
   - The drive root keeps `listSharedDriveFiles` with `path = name`. My Drive roots, piece folders
     and the refusal fallback keep the walk.
4. **Counters.** New lines and keys only:
   - pino INFO `[drive.structure] parent map`, with `kind=folders`, `root_kind`, `folders_listed`,
     `in_scope`, `out_of_scope`, `orphans`, `multi_parent` and `depth_cap`;
   - discovery text `  Parent map (files): in_scope=N out_of_scope=N orphans=N multi_parent=N depth_cap=N`;
   - forward text `  Parent map: out_of_scope=N changed file(s) outside the folder map (moved out of
     the tree, or parent not visible)`, only when N > 0 (`isOutsideFolderMap`; log only);
   - from item 2: pino WARN `[drive.structure] flat listing unavailable — walking recursively`
     with a `cause` key (status and reasons only);
   - from item 3: text `  Using FLAT list of the drive, cut to this folder…` and
     `  ⚠ flat listing unavailable (<cause>) — falling back to the recursive walk`.

   The chain walk (`makeReach`) is iterative and memoized. `MAX_DEPTH` now lives once, in
   `folder-tree.ts`.
5. **Tests**, 21 → 61.
   - `folder-tree.test.ts` (15, pure): a subtree not at the drive root, move, rename, move-out,
     orphans (missing parent, no parent, loop), multi-parent, a folder listed twice, depth cap, and
     the forward predicate.
   - `listing.test.ts` (25): the real client, structure and discovery code over a fake Drive that
     honours `q`, `corpora`, `orderBy`, `pageSize` and paging. It checks:
     - identity with the walk, for folders and files;
     - call counts and the depth cap;
     - the fallbacks (refused listing, refused file sweep, root's subtree missing), and no
       fallback for a 400 or a limit;
     - the drive root unchanged, and My Drive still walking;
     - dedupe, missing `createdTime` or `parents`, and `createdTime` ties.
   - Measured by the tests:
     - folder gather, in-drive root (2,345 drive folders, 600 under the root): 601 → 3 calls;
     - file discovery (2,500 folders and 751 files in the drive): 1,501 → 4 calls;
     - drive-root sweep (6,753 folders): 34 → 7 pages.

**Prepared, not run (needs a go):** `npm run probe-drive-listing -- --account-id <id> [--probe-only]`,
and `--all --probe-only` for the root-shape census (§5).
- It runs the production listing code and prints the folder sweep's page count, the wall time of each phase
  and the counters; never a name or an id.
- It measures both production paths, the forward folder sweep and the file discovery (which lists
  the folders again): about 1 + 2 × ceil(folders / 1000) + ceil(files / 1000) calls per account,
  $0. It reads a live Drive through the bot, and the bot credential comes from the database, so
  it runs only with a go.

Expected calls:

| Path | Before | After |
|---|---|---|
| Forward folder sweep, drive-root account (~6.75k folders) | 1 + 34 | 1 + 7 |
| Same, in-drive root of that size | 1 + ~6,754 | 1 + 7 |
| Bootstrap discovery, drive-root (~26k files) | 1 + ~131 | 1 + ~27 |
| Same, in-drive root | 1 + ~6,780 | 1 + 7 + ~27 |
| Catch-up (#66), per account | ~6,780 | ~35 once #66 uses `listSubtreeFiles` |

## 8. Decisions taken

- **H3-1.** A refused drive listing falls back to the walk, for folders inside a drive only.
- **H3-2.** `createdTime` and `lastModifyingUser` stay; `version,md5Checksum` are added and carried.
  `trashed` is not requested: under `q: trashed = false` it is always false.
- **H3-3.** The drive-root bootstrap keeps `path = name`. `listSubtreeFiles` gives #66 breadcrumbs for
  any root, the drive root included.
- **H3-4.** The forward counter is in, log only.
- **H3-5.** Based on `origin/main`. The prettier commit is byte-identical to the forward-reliability
  branch's for the shared files.
- **H3-6.** Always flat for roots inside a drive; the counters and the probe show the cost.
- **H3-7.** The recursive walks still have no visited set (My Drive only); out of scope.

## 9. Where the code and the issue disagree

- "the existing visited set already prevents loops": only `buildTreeFromFlat`, `buildAttributor` and
  `isInsideFolder` have one. `walkFoldersRecursive` and `traverseFolder` do not.
- The issue's field list omits `createdTime` and `lastModifyingUser`, which the code needs (H3-2).
- "A file moved out of the root's subtree increments an out of scope counter": a fresh listing cannot
  tell "moved out" from "never in". On the listing, `out_of_scope` measures the rest of the drive; a
  move-out shows only in the forward path (H3-4).
- `listSharedDriveFiles`' `maxFiles` option has no caller.
