// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import { writeFileSync } from 'node:fs';
import { prisma } from '../prisma';
import {
  buildAttributor,
  classifyFolders,
  gatherFolders,
  overlayPieceAnchors,
  type Attributor,
  type EntityMap,
  type PieceAnchor,
} from '../drive/structure';
import type { TraversedFile } from '../drive/types';
import { parseArgs, DEFAULT_CONCURRENCY, type Args, type BackfillRunResult } from './args';
import { log, rule, fmtMs, setOutputFile, getLogCapture, setLogCapture } from './output';
import { resetPhaseTimer, printPhaseSummary, timed } from './timing';
import { loadEntity } from './entity';
import { gatherFilesAuto, gatherFilesRecursive } from './discovery';
import {
  groupFilesByDate,
  persistCursor,
  persistStructureCache,
  persistBootstrapFilesCache,
  structureFingerprint,
  type DayBucket,
  type StructureCache,
  type BootstrapFilesCache,
} from './days';
import { buildCampaignNameDirectory, type CampaignNameDirectory } from './batch-types';
import { processBatch } from './process-batch';
import { runStructureOnly } from './structure-mode';

// ── Main ─────────────────────────────────────────────────────────────────────
//
// The backfill engine is exported as runBackfill() so programmatic callers
// (gub-drive-sync's watch mode) can drive it directly without shelling out.
// The CLI main() below is a thin wrapper: parse argv → set outputFile →
// runBackfill → exit.

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.outputPath) {
    setOutputFile(args.outputPath);
    writeFileSync(args.outputPath, '');
  }
  await runBackfill(args);
}

/**
 * Programmatic entry point for the backfill engine. Same behavior as the
 * CLI, but returns a structured result for queue-driven callers. When
 * args.captureLog is provided, every log() line is appended there in
 * addition to stdout — the watcher uses this to persist a tail as the
 * request's log_summary.
 *
 * Caller is responsible for prisma.$disconnect() (this function shares
 * the singleton; the watcher disconnects on its own shutdown).
 */
export async function runBackfill(args: Args): Promise<BackfillRunResult> {
  const prevCapture = getLogCapture();
  if (args.captureLog) setLogCapture(args.captureLog);
  // Heap watcher — emits a [mem] line every 30s with rss/heap/external
  // so OOM diagnostics survive even though the phase-summary block
  // can't print after SIGKILL. Cloud Run kills on rss exceeding the
  // Job's --memory limit; logging rss correlates directly.
  const memTicker = setInterval(() => {
    const m = process.memoryUsage();
    const mb = (n: number): number => Math.round(n / 1024 / 1024);
    log(
      `  [mem] rss=${mb(m.rss)}MB  heapUsed=${mb(m.heapUsed)}MB  heapTotal=${mb(m.heapTotal)}MB  external=${mb(m.external)}MB`,
    );
  }, 30_000);
  memTicker.unref();
  try {
    return await runBackfillInner(args);
  } finally {
    // Queue mode drains many rows in ONE process (up to 50 per Job
    // execution); an uncleared ticker would keep writing [mem] lines
    // into LATER rows' captureLog. .unref alone only frees the event
    // loop — it does not stop the ticks.
    clearInterval(memTicker);
    setLogCapture(prevCapture);
  }
}

async function runBackfillInner(args: Args): Promise<BackfillRunResult> {
  const overallStart = Date.now();
  const emptyResult = (): BackfillRunResult => ({
    scansProcessed: 0,
    filesProcessed: 0,
    durationMs: Date.now() - overallStart,
    finalCursorYmd: null,
    activeDaysFirst: null,
    activeDaysLast: null,
    activeDaysCount: 0,
    structureOnlyMode: false,
    bootstrapCompleted: false,
  });

  // Fresh phase timer for this invocation. Queue mode drains many rows
  // in the same process, so each row's runBackfill call gets its own
  // timer window.
  resetPhaseTimer();

  log('');
  log(rule(args.dryrun ? 'Backfill (dryrun — no DB writes)' : 'Backfill'));

  const ctx = await timed('setup', () => loadEntity(args));
  log(`  Entity: ${ctx.type}: ${ctx.name}  (${ctx.id})`);
  log(`  Folder: ${ctx.folderId}`);

  // Pieces of the scanned campaign (campaign scans only). Their folders are
  // part of the campaign's content — often SIBLINGS of the campaign root
  // (merged-variant folders) — so discovery gathers them too, tagging each
  // file with its piece. Account scans resolve pieces via the attributor's
  // piece-anchor overlay instead.
  const ctxPieceRows =
    ctx.type === 'campaign'
      ? await prisma.campaignPiece.findMany({
          where: { campaignId: ctx.id },
          select: { id: true, name: true, driveFolderId: true },
        })
      : [];
  const piecesById = new Map(
    ctxPieceRows
      .filter((p): p is typeof p & { driveFolderId: string } => !!p.driveFolderId)
      .map((p) => [p.id, { name: p.name, driveFolderId: p.driveFolderId }]),
  );
  if (piecesById.size > 0) {
    log(`  Pieces: ${piecesById.size} (folders gathered with the campaign)`);
  }

  // ── Stage 1: structure-only mode ──────────────────────────────────────────
  // Resolve + print the entity map, then exit. No file extraction. This is
  // the isolated validation surface for the structure read — eyeball the
  // map against the real tree before any of it drives attribution.
  if (args.structureOnly) {
    log('');
    log(rule('Structure resolution (Stage 1 — map only, no extraction)'));
    await runStructureOnly(ctx);
    return { ...emptyResult(), structureOnlyMode: true };
  }

  log(`  Sort: createdTime ${args.newestFirst ? 'DESC (newest first)' : 'ASC (oldest first)'}`);
  log('');

  // ── Stage 2: structure-aware attribution for account scans ───────────────
  // For account scans, resolve the folder topology FIRST, build the
  // file→entity attributor from it, and pass it into batch processing so
  // every campaign observation routes to its correct campaign bucket.
  // Campaign scans skip this — they scan within a single known campaign
  // and don't need cross-campaign attribution.
  let attributor: Attributor | null = null;
  let nameDirectory: CampaignNameDirectory | null = null;
  let familyByCampaignId: Map<string, string[]> | null = null;
  /** FolderNode.path by folder id — the deterministic breadcrumb (NOT the
   *  LLM-echoed folder_path). Used to persist campaign.driveFolderPath at
   *  creation so the merge's year gate has a structural year to read. */
  let folderPathById: Map<string, string> | null = null;
  if (ctx.type === 'account') {
    log(rule('Resolve structure (Stage 2 — file→entity attribution)'));
    // existingCampaigns is read fresh every chunk — auto-created
    // candidates during bootstrap mean the DB list grows mid-chain;
    // nameDirectory rebuilds against the current list. Cheap query.
    const existingCampaigns = (
      await prisma.campaign.findMany({
        where: { accountId: ctx.id, driveFolderId: { not: null } },
        select: { id: true, name: true, driveFolderId: true },
      })
    )
      .filter((c): c is { id: string; name: string; driveFolderId: string } => !!c.driveFolderId)
      .map((c) => ({ id: c.id, name: c.name, driveFolderId: c.driveFolderId }));
    log(`  Existing campaigns in DB: ${existingCampaigns.length}`);

    // ── Structure cache check ─────────────────────────────────────────
    //
    // Chunks 2..N of a bootstrap chain reuse the structure computed by
    // chunk #1. We trust the cache for bootstrap (chain runs in hours;
    // structure barely changes). For forward sync, we'll re-gather +
    // re-hash + compare fingerprint before reusing. Today this code
    // only runs from bootstrap mode, so cache-hit = trust.
    let entityMap: EntityMap | null = null;
    const cached = ctx.driveStructureClassification as StructureCache | null;
    if (cached && cached.entityMap) {
      log(`  ✓ Structure cache HIT  (fingerprint=${cached.fingerprint.slice(0, 12)}…)`);
      log(`    Skipping ~33s folder gather + ~1m45s LLM classify.`);
      entityMap = cached.entityMap as EntityMap;
    } else {
      log('  Gathering folders…');
      const isTTY = process.stdout.isTTY === true;
      let lastTick = Date.now();
      const folders = await timed('structure_walk', () =>
        gatherFolders(ctx.folderId, ctx.name, {
          onProgress: (n) => {
            if (!isTTY) return;
            if (Date.now() - lastTick < 150) return;
            lastTick = Date.now();
            process.stdout.write('\r' + `    …${n} folders so far`.padEnd(40));
          },
        }),
      );
      if (isTTY) process.stdout.write('\r' + ' '.repeat(40) + '\r');
      log(`  Gathered ${folders.length} folders.`);
      log('  Classifying with LLM…');
      entityMap = await timed('structure_classify', () =>
        classifyFolders({
          accountId: ctx.id,
          accountName: ctx.name,
          rootFolderId: ctx.folderId,
          folders,
          existingCampaigns,
        }),
      );
      // Persist for chunks 2..N. Fingerprint over the folder list so
      // forward sync can detect drift later.
      if (!args.dryrun) {
        const fingerprint = structureFingerprint(
          folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
        );
        await persistStructureCache(ctx.accountId, {
          fingerprint,
          entityMap,
          folders,
        });
        log(`  ✓ Structure cache WRITTEN  (fingerprint=${fingerprint.slice(0, 12)}…)`);
      }
    }
    const classifiedCounts = {
      existing: entityMap.classified.filter((c) => c.classification === 'existing_campaign').length,
      fresh: entityMap.classified.filter((c) => c.classification === 'new_campaign').length,
      acct: entityMap.classified.filter((c) => c.classification === 'account_level').length,
    };
    log(
      `  Classified: ${classifiedCounts.existing} existing campaigns, ${classifiedCounts.fresh} new candidates, ${classifiedCounts.acct} account-level  [${entityMap.driver}]`,
    );
    log('');

    // ── Piece-anchor overlay — fresh from the DB every chunk, NEVER cached.
    // Folders that belong to a campaign via campaign_pieces (merged-variant
    // folders) are pinned to their owning campaign, overriding whatever the
    // LLM classified them as. This is what makes a merge STICK: without it
    // the next scan re-creates the merged folder as a new campaign.
    const pieceRows = await prisma.campaignPiece.findMany({
      where: { campaign: { accountId: ctx.id } },
      select: {
        id: true,
        name: true,
        driveFolderId: true,
        campaignId: true,
        campaign: { select: { name: true } },
      },
    });
    const pieceAnchors: PieceAnchor[] = pieceRows
      .filter((p): p is typeof p & { driveFolderId: string } => !!p.driveFolderId)
      .map((p) => ({
        driveFolderId: p.driveFolderId,
        campaignId: p.campaignId,
        campaignName: p.campaign.name,
        pieceId: p.id,
        pieceName: p.name,
      }));
    if (pieceAnchors.length > 0) {
      entityMap = overlayPieceAnchors(entityMap, pieceAnchors);
      log(`  Piece anchors: ${pieceAnchors.length} folder(s) pinned to their owning campaign`);
      log('');
    }

    folderPathById = new Map(entityMap.allFolders.map((f) => [f.id, f.path]));
    attributor = buildAttributor(entityMap, pieceAnchors);
    familyByCampaignId = new Map(existingCampaigns.map((c) => [c.id, [c.name]]));
    for (const a of pieceAnchors) {
      const fam = familyByCampaignId.get(a.campaignId);
      if (fam) fam.push(a.pieceName);
      else familyByCampaignId.set(a.campaignId, [a.campaignName, a.pieceName]);
    }
    nameDirectory = buildCampaignNameDirectory(entityMap, existingCampaigns);
    log(
      `  Known-campaign vocabulary for per-file LLM: ${nameDirectory.knownCampaignNames.length} name${nameDirectory.knownCampaignNames.length === 1 ? '' : 's'}`,
    );
    log('');
  }

  // ── Files cache check ─────────────────────────────────────────────────
  //
  // Chunks 2..N of a bootstrap chain reuse the file list + active-date
  // buckets computed by chunk #1. Each chunk just advances the cursor
  // through the cached activeDates — no fresh files.list pagination
  // needed. Cache is NULLed on bootstrap completion (see persistCursor).
  log(rule('Discover files'));
  let allFiles: TraversedFile[];
  let activeDates: DayBucket[];
  const cachedFiles = ctx.driveBootstrapFiles as BootstrapFilesCache | null;
  if (cachedFiles && cachedFiles.files && cachedFiles.activeDates) {
    log(`  ✓ Files cache HIT  (${cachedFiles.files.length} files, ${cachedFiles.activeDates.length} active days)`);
    log(`    Skipping ~3 min file discovery + grouping.`);
    allFiles = cachedFiles.files;
    activeDates = cachedFiles.activeDates;
  } else {
    allFiles = await timed('file_discovery', () =>
      gatherFilesAuto(ctx.folderId, ctx.name, args.newestFirst),
    );
    // Campaign scans also gather each piece's folder, tagging files with
    // their piece. Piece-tagged copies WIN on id collision (a piece folder
    // nested inside the campaign root would otherwise double-count).
    if (piecesById.size > 0) {
      const byId = new Map(allFiles.map((f) => [f.id, f]));
      for (const [pieceId, info] of piecesById) {
        const pieceFiles = await timed('file_discovery', () =>
          gatherFilesRecursive(info.driveFolderId, `${ctx.name} · ${info.name}`, args.newestFirst),
        );
        for (const f of pieceFiles) byId.set(f.id, { ...f, pieceId });
      }
      allFiles = Array.from(byId.values());
      log(`  + piece folders gathered (${piecesById.size}) → total ${allFiles.length} files`);
    }
    log(`  Total files in folder: ${allFiles.length}`);
    // Nothing-to-do exits report bootstrapCompleted: TRUE — an empty
    // drive is trivially bootstrapped. Returning false here made an
    // all_remaining queue row fire a continuation, which hit the same
    // empty result and fired another: an unbounded self-triggering
    // Job chain until a human noticed.
    if (allFiles.length === 0) {
      log('  Nothing to do. Exiting.');
      return { ...emptyResult(), bootstrapCompleted: true };
    }

    activeDates = groupFilesByDate(allFiles);
    if (args.newestFirst) activeDates.reverse();
    if (activeDates.length === 0) {
      log('  No files have modifiedTime — nothing to scan. Exiting.');
      return { ...emptyResult(), bootstrapCompleted: true };
    }
    // Persist for chunks 2..N.
    if (!args.dryrun) {
      await persistBootstrapFilesCache(ctx.accountId, { files: allFiles, activeDates });
      log(`  ✓ Files cache WRITTEN  (${allFiles.length} files)`);
    }
  }
  log(`  Active days: ${activeDates.length}  (${activeDates[0]!.date} → ${activeDates[activeDates.length - 1]!.date})`);
  log('');

  if (args.dryrun) {
    log('  --dryrun is set: nothing will be written to the DB.');
  } else {
    log('  ⚠ Persisting to DB (system-staff attribution). Use --dryrun to preview.');
  }
  log('');

  // ── One-day scan ─────────────────────────────────────────────────────────
  //
  // Locked invariant: **one scan = one active day of file CRUD**. Each
  // invocation picks the first activeDate strictly greater than the
  // account's cursor, processes its files, persists the cursor, and
  // returns. Walking N days = N invocations — the queue chains
  // continuations one row at a time via backfill-queue.ts; CLI users
  // loop manually. The old --scans / --all / wall-clock-budget knobs
  // were removed; the engine no longer loops across active days.
  //
  // Why one-day-per-scan:
  //   - cursor advancement is unambiguous (scansProcessed ∈ {0,1})
  //   - persist failure can throw without losing other days' work
  //     (there are no other days in this run)
  //   - the structure walk's cost is amortized across the chain at
  //     the queue level, not the engine level
  //   - re-scan overlap on continuation chunks becomes impossible by
  //     construction

  let scansDone = 0;
  let filesProcessed = 0;
  const effectiveCursor: string | null = ctx.driveBootstrapCursor;
  const initialCursor = effectiveCursor;
  log(`  Cursor (accounts.drive_bootstrap_cursor): ${effectiveCursor ?? 'none — starting from earliest active day'}`);
  log('');

  let finalCursor: string | null = effectiveCursor;
  let bootstrapCompleted = false;
  // --flat: one scan over EVERYTHING, stamped today. Ignores the cursor,
  // skips the historical day-walk entirely.
  const nextDay = args.flat
    ? { date: new Date().toISOString().slice(0, 10), files: activeDates.flatMap((d) => d.files) }
    : activeDates.find((d) => !effectiveCursor || d.date > effectiveCursor);
  if (!nextDay) {
    log(rule(`No active days past ${effectiveCursor ?? '(start)'} — bootstrap caught up`));
    bootstrapCompleted = true;
    // Persist the completion flag even when no day was processed —
    // signals to the queue and UI that bootstrap is done. Cursor stays
    // at the last processed day (or null if the drive was empty).
    if (!args.dryrun && effectiveCursor) {
      await timed('persist_cursor', () =>
        persistCursor(ctx.accountId, effectiveCursor, true),
      );
    }
  } else {
    log(rule(`Scan: ${nextDay.date}  (${nextDay.files.length} file${nextDay.files.length === 1 ? '' : 's'})`));
    filesProcessed = nextDay.files.length;

    log('');

    const scanStart = Date.now();
    const outcome = await processBatch(
      nextDay.files,
      ctx,
      attributor,
      nameDirectory,
      folderPathById,
      piecesById.size > 0 ? piecesById : null,
      familyByCampaignId,
      !args.dryrun,
      nextDay.date,
      args.concurrency ?? DEFAULT_CONCURRENCY,
    );
    const scanMs = Date.now() - scanStart;

    // ── Print synthesized status_markdowns for this scan ──────────────
    log('');
    log(`  ── Synthesized (${outcome.synthesized.length} entit${outcome.synthesized.length === 1 ? 'y' : 'ies'}) ──`);
    if (outcome.synthesized.length === 0) {
      log('     (no entities synthesized this scan)');
    }
    for (const result of outcome.synthesized) {
      log('');
      const header =
        result.entityStatus === 'account'
          ? `Account: "${result.entityName}"`
          : result.entityStatus === 'piece'
            ? `Piece: "${result.entityName}"`
            : result.entityStatus === 'existing'
              ? `Campaign (existing): "${result.entityName}"`
              : `Campaign (NEW candidate): "${result.entityName}"`;
      log(`  ▸ ${header}`);
      log(
        `     ${result.observationsCount} obs / ${result.filesCount} file(s)  ·  synthesis ${fmtMs(result.synthesisMs)}`,
      );
      if (result.distillResult) {
        log(
          `     distill: ${result.distillResult.proposalsCreated} field changes / ${result.distillResult.notesWritten} notes`,
        );
      }
      log('     ┌── status_markdown ──────────────────');
      for (const line of result.synthesizedMarkdown.split('\n')) {
        log(`     │ ${line}`);
      }
      log('     └─────────────────────────────────────');
      if (result.synthesizedSensitiveMarkdown) {
        log('     ┌── status_sensitive_markdown ────── ⚠ restricted');
        for (const line of result.synthesizedSensitiveMarkdown.split('\n')) {
          log(`     │ ${line}`);
        }
        log('     └─────────────────────────────────────');
      }
    }

    log('');
    log(`  ✓ Scan done in ${fmtMs(scanMs)}  (${nextDay.date})`);
    log('');

    // Day-commit gate: a synthesis/apply failure means at least one
    // entity's day is NOT in the DB. Throw BEFORE the cursor persists so
    // the queue retry re-runs this day — the alternative is silent
    // permanent loss (the day-walk never revisits a committed day).
    // Dryrun previews report the count but complete normally.
    if (!args.dryrun && outcome.stage3Failures > 0) {
      throw new Error(
        `${outcome.stage3Failures} entity synthesis/apply failure(s) on ${nextDay.date} — day NOT committed; the queue retry re-runs it`,
      );
    }

    scansDone = 1;
    finalCursor = nextDay.date;

    // Was this the last active day? If so, bootstrap is complete after
    // this chunk — mark it. The find returns the FIRST date strictly
    // greater than nextDay.date; if there isn't one, we're done.
    const followUpDay = activeDates.find((d) => d.date > nextDay.date);
    bootstrapCompleted = !followUpDay;

    // Persist the cursor. NO try/catch — failure must propagate. With
    // only one day per chunk, swallowing here would leave the row
    // reporting `completed` while the DB cursor stays stale. Synthesis
    // writes are already committed above (processBatch with
    // persist=true), so letting this throw doesn't lose observation
    // data — only the cursor stamp, which the next chunk will redo
    // from the same starting point.
    if (!args.dryrun) {
      await timed('persist_cursor', () =>
        persistCursor(ctx.accountId, nextDay.date, bootstrapCompleted),
      );
    }
  }

  const overallMs = Date.now() - overallStart;
  log(
    rule(
      `Backfill done — ${scansDone} scan / ${filesProcessed} file${filesProcessed === 1 ? '' : 's'} processed in ${fmtMs(overallMs)}`,
    ),
  );

  // Phase summary goes LAST so it survives the 40-line tailLogSummary
  // and appears in the gub-admin Recent backfill requests row.
  printPhaseSummary(overallMs);
  log('');

  return {
    scansProcessed: scansDone,
    filesProcessed,
    durationMs: overallMs,
    finalCursorYmd: finalCursor !== initialCursor ? finalCursor : null,
    activeDaysFirst: activeDates[0]!.date,
    activeDaysLast: activeDates[activeDates.length - 1]!.date,
    activeDaysCount: activeDates.length,
    structureOnlyMode: false,
    bootstrapCompleted,
  };
}
