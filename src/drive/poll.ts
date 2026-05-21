/**
 * drive.poll.ts — Incremental polling via Drive's changes.list API.
 *
 * Replaces the "always-do-a-full-folder-scan" trigger with a cheap delta call:
 * Drive tells us what's changed since the last token; we kick off a full scan
 * (kickoffFullSync pattern, fire-and-forget) only when there are in-scope
 * changes. No changes → save the new terminal token, return 200 fast.
 *
 * Cadence is enforced upstream by Cloud Scheduler (admin updates the cron
 * expression via the gub-admin UI; this handler doesn't gate on a DB-stored
 * interval). The handler trusts that Cloud Scheduler is calling at the right
 * frequency.
 *
 * Auth: this handler currently runs unauthenticated, matching the rest of
 * /integrations/google-drive/* (the existing KNOWN DEBT). Item 7b adds
 * OIDC-token verification at the gateway in one pass for all admin endpoints.
 *
 * Failure modes:
 *   - No saved token (cold install or post-token-expiry recovery)
 *     → returns { outcome: 'bootstrap_required' }; caller maps to HTTP 503.
 *       Operator runs /run-full-sync (admin UI "Run sync now") to bootstrap.
 *   - Saved token is past Drive's ~7d idle window (PageTokenExpiredError)
 *     → clears the saved token, returns same 'bootstrap_required'.
 *   - Drive throws on the call itself
 *     → records 'errored' outcome, re-throws; the caller maps to HTTP 5xx.
 *       Next poll will retry from the same saved token (no token loss).
 *   - Changes returned but none are in-scope (folder filter rejects all)
 *     → persists the new terminal token, returns 'no_changes'.
 *   - Changes returned, ≥1 in-scope, and a sync is already running
 *     → does NOT re-fire kickoffFullSync (the in-flight one will pick them up
 *       implicitly via delta-snapshot logic). Persists the new terminal
 *       token; returns 'changes_pending_existing_run'.
 */

import { config } from '../config';
import { prisma } from '../prisma';
import { logger } from '../logger';
import {
  getStartPageToken,
  isInsideFolder,
  listChanges,
  PageTokenExpiredError,
} from './client';
import { SyncAlreadyRunningError, startFullSync } from './runner';

export type PollOutcome =
  | 'no_changes'
  | 'changes_dispatched'
  | 'changes_pending_existing_run'
  | 'bootstrap_required'
  | 'errored';

export interface PollResult {
  outcome: PollOutcome;
  /** Number of changes Drive returned (post-deduplication, pre-folder-filter). */
  changesReturned: number;
  /** Number of those that survived the in-scope folder filter. */
  changesInScope: number;
  /** syncRunId if this poll dispatched a full sync; null otherwise. */
  dispatchedSyncRunId: string | null;
  /**
   * Promise from the dispatched full sync (if outcome='changes_dispatched').
   * The Job-mode caller (main.ts) awaits this so the process doesn't exit
   * while the sync is still running in-process. Null when no sync was
   * dispatched. Errors are already logged inside the runner; the caller
   * is free to swallow them here too rather than failing the whole poll.
   */
  dispatchedSyncPromise: Promise<unknown> | null;
  /** When poll outcome is 'errored', the human-readable reason. */
  errorMessage: string | null;
}

/**
 * Read-modify-write the singleton drive_sync_state row. Helper because every
 * code path in runIncrementalPoll touches lastPolledAt + lastOutcome.
 */
async function persistOutcome(opts: {
  outcome: PollOutcome;
  pageToken?: string | null; // explicit null clears; undefined = leave as-is
  syncRunId?: string | null;
}): Promise<void> {
  const data: {
    lastPolledAt: Date;
    lastOutcome: PollOutcome;
    pageToken?: string | null;
    lastFullSyncRunId?: string | null;
  } = {
    lastPolledAt: new Date(),
    lastOutcome: opts.outcome,
  };
  if (opts.pageToken !== undefined) data.pageToken = opts.pageToken;
  if (opts.syncRunId !== undefined) data.lastFullSyncRunId = opts.syncRunId;

  await prisma.driveSyncState.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data,
  });
}

export async function runIncrementalPoll(): Promise<PollResult> {
  const state = await prisma.driveSyncState.findUnique({ where: { id: 1 } });

  // ── Bootstrap path ──────────────────────────────────────────────────────
  // No row, or row exists with no token → bootstrap_required.
  if (!state || !state.pageToken) {
    await persistOutcome({ outcome: 'bootstrap_required' });
    logger.warn(
      { hasState: !!state },
      '[drive.poll] no saved page token — bootstrap required',
    );
    return {
      outcome: 'bootstrap_required',
      changesReturned: 0,
      changesInScope: 0,
      dispatchedSyncRunId: null,
      dispatchedSyncPromise: null,
      errorMessage: null,
    };
  }

  // ── Call changes.list ───────────────────────────────────────────────────
  let result;
  try {
    result = await listChanges(state.pageToken);
  } catch (err) {
    if (err instanceof PageTokenExpiredError) {
      await persistOutcome({ outcome: 'bootstrap_required', pageToken: null });
      logger.warn('[drive.poll] saved token expired — bootstrap required');
      return {
        outcome: 'bootstrap_required',
        changesReturned: 0,
        changesInScope: 0,
        dispatchedSyncRunId: null,
        dispatchedSyncPromise: null,
        errorMessage: null,
      };
    }
    await persistOutcome({ outcome: 'errored' });
    logger.error({ err }, '[drive.poll] changes.list threw');
    throw err; // saved token is preserved; next poll retries from the same point
  }

  // ── Folder-tree filter (defensive belt) ─────────────────────────────────
  // changes.list should already be restricted to files the SA can see, which
  // is just our root tree. But Drive permission inheritance can break in
  // weird ways; reject anything outside the configured root explicitly.
  // (If DRIVE_ROOT_FOLDER_ID is unset, accept everything — dev-mode behavior.)
  const root = config.DRIVE_ROOT_FOLDER_ID;
  let inScope = result.changes;
  if (root) {
    const filtered = await Promise.all(
      result.changes.map(async (c) => {
        // Removals don't have a `file` payload; let them through (we want to
        // process deletions of files we previously snapshot'd).
        if (c.removed) return c;
        if (!c.fileId) return null;
        const inside = await isInsideFolder(c.fileId, root).catch(() => false);
        return inside ? c : null;
      }),
    );
    inScope = filtered.filter((c): c is NonNullable<typeof c> => c !== null);
  }

  // ── Branch on what we found ─────────────────────────────────────────────
  if (inScope.length === 0) {
    await persistOutcome({
      outcome: 'no_changes',
      pageToken: result.newStartPageToken,
    });
    logger.info(
      { changesReturned: result.changes.length, changesInScope: 0 },
      '[drive.poll] no in-scope changes',
    );
    return {
      outcome: 'no_changes',
      changesReturned: result.changes.length,
      changesInScope: 0,
      dispatchedSyncRunId: null,
      dispatchedSyncPromise: null,
      errorMessage: null,
    };
  }

  // Changes are in-scope. Dispatch a full sync to process them via the
  // existing pipeline (the sync uses delta-snapshot logic, so unchanged
  // files in folders that happen to share a parent with a changed file
  // are skipped efficiently).
  let dispatchedSyncRunId: string | null = null;
  let dispatchedSyncPromise: Promise<unknown> | null = null;
  let outcome: PollOutcome = 'changes_dispatched';
  try {
    const { syncRunId, promise } = await startFullSync();
    dispatchedSyncRunId = syncRunId;
    // Attach a catch handler so an unhandled rejection doesn't crash the
    // process, but also surface the promise to the caller so the Job
    // execution can await it (otherwise the process exits before the
    // sync finishes).
    dispatchedSyncPromise = promise.catch((err: unknown) => {
      logger.error(
        { err, syncRunId },
        '[drive.poll] dispatched sync rejected outside runner',
      );
    });
    logger.info(
      { syncRunId, changesInScope: inScope.length },
      '[drive.poll] dispatched full sync for in-scope changes',
    );
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      // A sync is already in flight; it will pick up these changes via the
      // delta-snapshot logic (which compares modifiedTime + size + content
      // hash). Don't fire another sync; just note the deferred state.
      outcome = 'changes_pending_existing_run';
      dispatchedSyncRunId = err.existingRunId;
      logger.info(
        { existingSyncRunId: err.existingRunId, changesInScope: inScope.length },
        '[drive.poll] existing sync already in flight — changes will be picked up there',
      );
    } else {
      await persistOutcome({ outcome: 'errored' });
      logger.error({ err }, '[drive.poll] startFullSync threw');
      throw err;
    }
  }

  // Persist the new terminal token regardless of dispatch path. The contract
  // is that we've successfully consumed every change up to and including
  // newStartPageToken; the next poll starts from there.
  await persistOutcome({
    outcome,
    pageToken: result.newStartPageToken,
    syncRunId: dispatchedSyncRunId,
  });

  return {
    outcome,
    changesReturned: result.changes.length,
    changesInScope: inScope.length,
    dispatchedSyncRunId,
    dispatchedSyncPromise,
    errorMessage: null,
  };
}

/**
 * Used at the end of /run-full-sync to capture a fresh start page token, so
 * the very first /poll has a token to call from. Idempotent: callable many
 * times, just records a different "now" each call.
 *
 * Persists nothing if Drive throws — the caller's bootstrap completed
 * successfully in every other respect, and we'd rather a missing token
 * surface as 'bootstrap_required' on next poll than as a sync failure.
 */
export async function captureStartPageTokenAfterFullSync(syncRunId: string): Promise<void> {
  let token: string;
  try {
    token = await getStartPageToken();
  } catch (err) {
    logger.error(
      { err, syncRunId },
      '[drive.poll] getStartPageToken failed at end of full sync — leaving sync state untouched',
    );
    return;
  }

  await prisma.driveSyncState.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      pageToken: token,
      lastFullSyncRunId: syncRunId,
      lastOutcome: 'no_changes', // post-bootstrap, the next poll has nothing new
      lastPolledAt: new Date(),
    },
    update: {
      pageToken: token,
      lastFullSyncRunId: syncRunId,
      lastOutcome: 'no_changes',
      lastPolledAt: new Date(),
    },
  });

  logger.info(
    { syncRunId },
    '[drive.poll] persisted fresh start page token at end of full sync',
  );
}
