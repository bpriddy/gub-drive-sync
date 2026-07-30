/**
 * backfill/ — the single-day backfill engine.
 *
 * **One scan = one day of file CRUD.** Each invocation processes the
 * first activeDate strictly greater than the account's cursor and exits.
 * Walking multiple days = invoking N times (queue chains continuations
 * via gub-drive-sync/src/drive/backfill-queue.ts; CLI users loop
 * manually). Locked by design — see "Drive Sync: One Day Per Scan"
 * decision. The old `--all` / `--scans N` / wall-clock-budget knobs
 * were removed; the engine no longer loops across active days.
 *
 * Picks a paginated batch of files from an account's Drive folder, resolves
 * the folder→entity map, attributes each file to its owning entity,
 * extracts + distills observations per entity, synthesizes one
 * status_markdown per entity, and prints (and optionally persists)
 * everything.
 *
 * Two modes, controlled by --dryrun:
 *   - Default (no --dryrun): persist. Field guesses become entity-column
 *     updates; synthesized status_markdowns get written to the entity;
 *     new campaign candidates get CREATEd. All writes attributed to the
 *     Drive Sync system staff (no review queue — that's the design for
 *     backfill, where per-day human review is impractical).
 *   - --dryrun: preview only. Nothing is written to the DB. Use to
 *     inspect what would happen — observation routing, field guesses,
 *     synthesized status_markdowns — before committing.
 *
 * Scans CHAIN — synthesis merges each day's observations with the
 * entity's existing status_markdown (prior context/transient bullets
 * are extracted and fed back in, so newer information supersedes older
 * as the cursor advances). Day-by-day replay is driven by the queue's
 * one-day continuation chain (src/drive/backfill-queue.ts), not a
 * separate replay driver.
 *
 * Honest trade-off: per-file CONTENT is the file's CURRENT state, not
 * historical — the LLM sees today's content. Per-file metadata is only
 * what files.list returns (modifiedTime, lastModifyingUser); there is
 * no revision walking. Acceptable proxy per the "creation-order
 * processing gives temporal evolution via processing order" model for
 * backfill; revision-content replay was rejected, not deferred (see
 * docs/edit-stats-decision.md).
 *
 * Usage:
 *   npm run backfill -- --account-id <uuid>
 *     → Run the backfill. Writes entity columns + *_changes + new
 *       campaign rows. System-staff attribution.
 *
 *   npm run backfill -- --account-id <uuid> --dryrun
 *     → Preview only. Nothing written. Same flow, same logs, no DB
 *       changes — use to inspect what would happen before committing.
 *
 *   npm run backfill -- --account-id <uuid> --newest-first
 *     → Pick the LATEST active day past the cursor instead of the
 *       earliest. Same one-day semantics.
 *
 *   npm run backfill -- --account-id <uuid> --structure
 *     → Resolve + print the folder→entity map only. No extraction, no
 *       writes. Use to inspect the structure scan against a real tree.
 *
 * Flags:
 *   --account-id <uuid>  OR --campaign-id <uuid>  (exactly one)
 *   --newest-first       Pick the NEWEST active day past cursor; default
 *                        is OLDEST (which is what catchup wants).
 *   --flat               Process EVERY file in ONE scan stamped with
 *                        today's date — no day-by-day replay, no cursor
 *                        gating. Marks bootstrap completed.
 *   --concurrency <n>    Per-file worker count within one day's batch
 *                        (integer 1–16; default 4). 1 = fully serial.
 *   --output <path>      Tee all output to a file
 *   --structure          Account-only. Print the entity map and exit.
 *   --dryrun             Skip DB writes — preview only. Default is to
 *                        persist (system-staff attribution).
 */
// Public surface of the backfill engine (formerly the scripts/backfill.ts
// monolith, split into logical modules and later promoted into src/).
// Imported as '../backfill' by the queue drainer; also the CLI entry.
import { prisma } from '../prisma';
import { main } from './run';

export { runBackfill } from './run';
export { parseArgs, type Args, type BackfillRunResult } from './args';
export { isForeignCampaignTag } from './routing';

if (require.main === module) {
  main()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      if (err instanceof Error && err.stack) console.error(err.stack);
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
