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
 * Each batch is INDEPENDENT — synthesis runs with prior_status = null
 * every time. Daily-snapshot timeline replay is a separate driver
 * (Stage 4) that loops this script over historical createdTime windows.
 *
 * Honest trade-off: per-file CONTENT is the file's CURRENT state, not
 * historical. We track revision METADATA (editor, timestamp) accurately,
 * but the LLM sees today's content. Acceptable proxy per the "creation-
 * order processing gives temporal evolution via processing order" model
 * for backfill; revision-content replay is a later refinement.
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
 *   npm run backfill -- --account-id <uuid> --batch-size 100
 *     → First 100 files
 *
 *   npm run backfill -- --account-id <uuid> --batch 1
 *     → Files 31–60 (second batch of 30)
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
