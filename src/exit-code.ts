/**
 * exit-code.ts — the process exit code for a mode that finished without
 * throwing (a throw is always 1, in main.ts).
 *
 * Cloud Run marks an execution FAILED on a non-zero exit (the job runs with
 * --max-retries=0, so nothing re-runs it). The queue-draining modes used to
 * exit 0 whatever the drain did, so a run that failed rows read SUCCEEDED.
 * Now they exit 1 when the drain ended with a row it could not land:
 * terminally failed, or re-queued and still pending at exit. A row that was
 * re-queued and then completed within the same execution is a recovery and
 * exits 0 — its retries stay visible as WARN lines and in `recovered`.
 *
 * Config-free so the unit suite can import it (main.ts runs on import).
 */
export interface DrainCounts {
  failed: number;
  requeuedAtExit: number;
}

function drainOf(mode: string, outcome: Record<string, unknown>): Partial<DrainCounts> | null {
  const drain =
    mode === 'backfill-pending' ? outcome : mode === 'forward-all' ? outcome['drain'] : null;
  return drain && typeof drain === 'object' ? (drain as Partial<DrainCounts>) : null;
}

export function exitCodeFor(mode: string, outcome: Record<string, unknown>): 0 | 1 {
  const drain = drainOf(mode, outcome);
  if (!drain) return 0;
  return (drain.failed ?? 0) > 0 || (drain.requeuedAtExit ?? 0) > 0 ? 1 : 0;
}

/** The drain counts behind a non-zero exit, for the failure log line. */
export function drainCountsFor(mode: string, outcome: Record<string, unknown>): DrainCounts {
  const drain = drainOf(mode, outcome);
  return { failed: drain?.failed ?? 0, requeuedAtExit: drain?.requeuedAtExit ?? 0 };
}
