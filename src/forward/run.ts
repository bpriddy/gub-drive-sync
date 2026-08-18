/**
 * forward/run.ts — the Activity-driven forward driver (forward-sync v2).
 *
 * One run per queue row: ask the Activity API what changed since the
 * account's timestamp cursor, scan exactly those files through the scan
 * core in PROPOSE mode (forward proposes; review applies — see
 * docs/forward-sync-v2-design.md), tally per-editor edit events, and
 * advance the cursor crash-safely per committed day-group.
 *
 * Returns the same result shape as the day-walk driver so the queue's
 * processOne consumes both drivers identically. bootstrapCompleted is
 * always true here — a forward run drains its whole window; there is
 * never a continuation chain.
 */

import { prisma } from '../prisma';
import { getFileMetadata } from '../drive/client';
import { notifyReviewers } from '../drive/notify';
import type { TraversedFile } from '../drive/types';
import { summarizeError } from '../progress';
import { loadEntity } from '../backfill/entity';
import { DEFAULT_CONCURRENCY, type Args, type BackfillRunResult } from '../backfill/args';
import { resolveAccountStructure } from '../backfill/structure-stage';
import { processBatch } from '../scan/process-batch';
import { log, rule, fmtMs, getLogCapture, setLogCapture } from '../scan/output';
import { resetPhaseTimer, printPhaseSummary, timed } from '../scan/timing';
import { queryActivityWindow, foldEvents, ymdUtc } from './activity';
import { resolveActors } from './people';
import { writeRunEditStats } from './stats';

/** Absorbs Activity API ingestion lag at the window edge (design Q4). */
const OVERLAP_MS = 2 * 60 * 1000;

export interface ForwardArgs {
  accountId: string;
  /** The drive_sync_runs row driving this run — stats key their
   *  contribution to it (run framing; retries replace themselves). */
  syncRunId: string;
  captureLog?: string[];
}

export async function runForward(fargs: ForwardArgs): Promise<BackfillRunResult> {
  const prevCapture = getLogCapture();
  if (fargs.captureLog) setLogCapture(fargs.captureLog);
  try {
    return await runForwardInner(fargs);
  } finally {
    setLogCapture(prevCapture);
  }
}

async function runForwardInner(fargs: ForwardArgs): Promise<BackfillRunResult> {
  const overallStart = Date.now();
  resetPhaseTimer();
  const result = (over: Partial<BackfillRunResult>): BackfillRunResult => ({
    scansProcessed: 0,
    filesProcessed: 0,
    durationMs: Date.now() - overallStart,
    finalCursorYmd: null,
    activeDaysFirst: null,
    activeDaysLast: null,
    activeDaysCount: 0,
    structureOnlyMode: false,
    // Forward never chains continuations — the run drains its window.
    bootstrapCompleted: true,
    ...over,
  });

  log('');
  log(rule('Forward sync (Activity-driven — proposes for review)'));

  const account = await prisma.account.findUniqueOrThrow({
    where: { id: fargs.accountId },
    select: {
      name: true,
      driveFolderId: true,
      driveBootstrapCompletedAt: true,
      driveForwardCursorAt: true,
    },
  });
  if (!account.driveFolderId) {
    log('  No drive_folder_id — nothing to sync.');
    return result({});
  }
  if (!account.driveBootstrapCompletedAt) {
    log('  Bootstrap not complete — forward sync starts after bootstrap. Skipping.');
    return result({});
  }

  const to = new Date();
  const from = account.driveForwardCursorAt ?? account.driveBootstrapCompletedAt;
  const queryFrom = new Date(from.getTime() - OVERLAP_MS);
  log(`  Account: ${account.name}  (${fargs.accountId})`);
  log(`  Window:  (${from.toISOString()} → ${to.toISOString()}]  (+${OVERLAP_MS / 1000}s overlap)`);

  const events = await timed('activity_query', () =>
    queryActivityWindow(account.driveFolderId!, queryFrom.toISOString(), to.toISOString()),
  );
  const folded = foldEvents(events);
  log(
    `  Activity: ${folded.totalEvents} event(s) → ${[...folded.filesByDay.values()].reduce((n, s) => n + s.size, 0)} file-day(s) across ${folded.filesByDay.size} day(s)` +
      `${folded.deletionEvents > 0 ? `; ${folded.deletionEvents} deletion(s) observed (dossiers do not react — Q2)` : ''}`,
  );

  const advanceCursor = async (toWhen: Date): Promise<void> => {
    await prisma.account.update({
      where: { id: fargs.accountId },
      data: { driveForwardCursorAt: toWhen, driveLastSyncedAt: new Date() },
    });
  };

  if (folded.filesByDay.size === 0) {
    await advanceCursor(to);
    log('  Nothing changed in the window. Cursor advanced.');
    return result({});
  }

  const actorEmailBy = await timed('actor_resolve', () => resolveActors(folded.actorResources));

  // Same context + attribution the day-walk driver uses — but with the
  // forward cache policy: re-gather every run, re-classify only on
  // fingerprint drift.
  const ctxArgs: Args = {
    accountId: fargs.accountId,
    newestFirst: false,
    outputPath: null,
    structureOnly: false,
    dryrun: false,
  };
  const ctx = await timed('setup', () => loadEntity(ctxArgs));
  const structure = await resolveAccountStructure(ctx, {
    trustCache: false,
    persistCache: true,
  });

  const days = [...folded.filesByDay.keys()].sort();
  // Run-date stamping (user ruling, 2026-08-14): this is TODAY's scan of
  // everything since the cursor — ONE batch, one date, regardless of which
  // calendar days the events fell on. Each changed file is scanned exactly
  // once with its current content (a file edited on both sides of midnight
  // is one scan, not two). Event-day precision lives where it belongs:
  // drive_edit_stats stays keyed by the true event day below.
  const scanDate = ymdUtc(to.toISOString());
  const changedIds = new Set<string>();
  for (const set of folded.filesByDay.values()) for (const id of set) changedIds.add(id);
  log('');
  log(
    rule(
      `Forward scan ${scanDate}: ${changedIds.size} changed file${changedIds.size === 1 ? '' : 's'} across ${days.length} event day(s)`,
    ),
  );

  // Current metadata for the changed files. Vanished files (deleted
  // after the window) skip; folders never scan.
  const files: TraversedFile[] = [];
  for (const id of changedIds) {
    let meta;
    try {
      meta = await timed('file_metadata', () => getFileMetadata(id));
    } catch (err) {
      log(`    ⚠ metadata fetch failed for ${id}: ${summarizeError(err)} — skipping`);
      continue;
    }
    if (!meta?.id || !meta.name) {
      log(`    (file ${id} gone — skipped)`);
      continue;
    }
    if (meta.mimeType === 'application/vnd.google-apps.folder') continue;
    const parentId = meta.parents?.[0] ?? null;
    const parentPath = (parentId && structure.folderPathById.get(parentId)) || ctx.name;
    files.push({
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType ?? 'application/octet-stream',
      parents: meta.parents ?? [],
      path: `${parentPath} / ${meta.name}`,
      modifiedTime: meta.modifiedTime ?? null,
      modifiedByEmail: meta.lastModifyingUser?.emailAddress ?? null,
      createdTime: meta.createdTime ?? null,
      size: meta.size ? Number(meta.size) : null,
      isFolder: false,
      ...(meta.shortcutDetails?.targetId && meta.shortcutDetails?.targetMimeType
        ? {
            shortcutTarget: {
              id: meta.shortcutDetails.targetId,
              mimeType: meta.shortcutDetails.targetMimeType,
            },
          }
        : {}),
    });
  }

  let filesProcessed = 0;
  let scansProcessed = 0;
  if (files.length > 0) {
    const outcome = await processBatch(files, {
      ctx,
      attributor: structure.attributor,
      nameDirectory: structure.nameDirectory,
      folderPathById: structure.folderPathById,
      piecesById: null,
      familyByCampaignId: structure.familyByCampaignId,
      application: 'propose',
      editedAt: scanDate,
      concurrency: DEFAULT_CONCURRENCY,
    });
    // Window-commit gate: don't advance the cursor unless every entity's
    // proposals landed — the queue retry re-runs the identical window.
    if (outcome.stage3Failures > 0) {
      throw new Error(
        `${outcome.stage3Failures} stage-3 failure(s) — cursor NOT advanced; retry re-runs this window`,
      );
    }
    filesProcessed = files.length;
    scansProcessed = 1;
  }

  // Edit stats use the SAME day framing as the scan (user ruling
  // 2026-08-15): this run's whole-window tallies, dated by the run.
  // Written before the cursor advances; a retry replaces its own rows.
  const statRows = await writeRunEditStats({
    accountId: fargs.accountId,
    syncRunId: fargs.syncRunId,
    day: scanDate,
    tallies: folded.editTallies,
    actorEmailBy,
  });
  if (statRows > 0) log(`  ✎ edit stats: ${statRows} (file × actor) row(s) dated ${scanDate}`);

  await advanceCursor(to);

  // Reviewer fan-out for whatever this window proposed (existing notify
  // machinery; grouped per reviewer; console mail driver in dev).
  try {
    const notified = await notifyReviewers();
    log(`  ✉ notify: ${JSON.stringify(notified)}`);
  } catch (err) {
    log(`  ⚠ notify failed (proposals remain pending): ${summarizeError(err)}`);
  }

  const overallMs = Date.now() - overallStart;
  log('');
  log(
    rule(
      `Forward sync done — ${scansProcessed} day-scan(s) / ${filesProcessed} file(s) in ${fmtMs(overallMs)}`,
    ),
  );
  printPhaseSummary(overallMs);

  return result({
    scansProcessed,
    filesProcessed,
    finalCursorYmd: scanDate,
    activeDaysFirst: days[0] ?? null,
    activeDaysLast: days[days.length - 1] ?? null,
    activeDaysCount: days.length,
  });
}
