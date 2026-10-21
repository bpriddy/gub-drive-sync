// Part of the scan core (src/scan/) — mode-agnostic batch machinery shared
// by every driver (day-walk backfill today; the Activity forward driver next).
import { logger } from '../logger';
import { log, rule, fmtMs } from './output';

// ── Phase timing ─────────────────────────────────────────────────────────────
//
// Each invocation builds a flat map of {phase → cumulative ms}. The hot
// paths wrap their work with `await timed('phase', () => ...)`; the
// summary is printed as the LAST log block at end of runBackfill so it
// survives the 40-line `tailLogSummary` clip and lands in the gub-admin
// log_summary column. Reset at the top of every runBackfillInner.
//
// Used to answer "where is the 85 minutes going on a single 1-day scan."

class PhaseTimer {
  private totals = new Map<string, number>();
  add(phase: string, ms: number): void {
    this.totals.set(phase, (this.totals.get(phase) ?? 0) + ms);
  }
  summary(): { rows: Array<{ phase: string; ms: number; pct: number }>; totalMs: number } {
    const total = Array.from(this.totals.values()).reduce((s, v) => s + v, 0);
    const rows = Array.from(this.totals.entries())
      .map(([phase, ms]) => ({ phase, ms, pct: total > 0 ? (ms / total) * 100 : 0 }))
      .sort((a, b) => b.ms - a.ms);
    return { rows, totalMs: total };
  }
}

let phaseTimer: PhaseTimer | null = null;

export async function timed<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  if (!phaseTimer) return fn();
  const start = Date.now();
  try {
    return await fn();
  } finally {
    phaseTimer.add(phase, Date.now() - start);
  }
}

/** Pretty-name table so phase keys render as human labels in the summary. */
const PHASE_LABELS: Record<string, string> = {
  setup: 'Setup (loadEntity)',
  structure_walk: 'Drive walk (folders)',
  structure_classify: 'Classify folders (LLM)',
  file_discovery: 'Discover files (Drive)',
  extract_text: 'Extract text (per-file)',
  interpret_file: 'Interpret file (per-file LLM)',
  idea_extract: 'Idea extraction (per-deck LLM)',
  idea_merge: 'Idea match/merge (serial LLM+DB)',
  interpret_asset_folder: 'Asset folders (name-only LLM)',
  distill: 'Distill (per-entity LLM)',
  synthesis: 'Synthesize (per-entity LLM)',
  db_writes: 'DB writes (persistTarget)',
  persist_cursor: 'Persist cursor (DB)',
};

export function printPhaseSummary(wallClockMs: number): void {
  if (!phaseTimer) return;
  const { rows, totalMs: instrumentedMs } = phaseTimer.summary();
  if (rows.length === 0) return;
  log('');
  log(rule('Phase timing (this scan)'));
  const labelWidth = Math.max(...rows.map((r) => (PHASE_LABELS[r.phase] ?? r.phase).length));
  const timeWidth = Math.max(...rows.map((r) => fmtMs(r.ms).length));
  for (const r of rows) {
    const label = (PHASE_LABELS[r.phase] ?? r.phase).padEnd(labelWidth);
    const t = fmtMs(r.ms).padStart(timeWidth);
    const barLen = Math.round(r.pct / 5); // 20-wide bar
    const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
    const pct = `${r.pct.toFixed(0)}%`.padStart(4);
    log(`  ${label}   ${t}   ${bar}  ${pct}`);
  }
  log('  ' + '─'.repeat(labelWidth + 3 + timeWidth + 3 + 20 + 2 + 4));
  log(
    `  ${'Instrumented total'.padEnd(labelWidth)}   ${fmtMs(instrumentedMs).padStart(timeWidth)}`,
  );
  const untracked = wallClockMs - instrumentedMs;
  if (untracked > 0) {
    log(
      `  ${'Wall-clock total'.padEnd(labelWidth)}   ${fmtMs(wallClockMs).padStart(timeWidth)}   (un-instrumented: ${fmtMs(untracked)})`,
    );
  } else {
    log(`  ${'Wall-clock total'.padEnd(labelWidth)}   ${fmtMs(wallClockMs).padStart(timeWidth)}`);
  }
  printPeakMemory();
}

/**
 * Last line of the run summary: the process's peak RSS. It is a PROCESS
 * high-water mark (the kernel keeps one number per process), not this run's —
 * one execution can drain several queue rows — so read it as "the most this
 * job execution has needed so far". Also written as a structured line, so the
 * peak can be queried and charted without parsing the captured log.
 */
function printPeakMemory(): void {
  const mib = (n: number): number => Math.round(n / 1024 / 1024);
  const peakRssBytes = process.resourceUsage().maxRSS * 1024; // maxRSS is in KiB
  const heapUsedBytes = process.memoryUsage().heapUsed;
  log(
    `  Peak memory: RSS ${mib(peakRssBytes)} MiB (process high-water mark), ` +
      `heap used ${mib(heapUsedBytes)} MiB now`,
  );
  logger.info({ peakRssBytes, heapUsedBytes }, '[drive.memory] run peak');
}

/** Fresh timer for a new run (was `phaseTimer = new PhaseTimer()` inline). */
export function resetPhaseTimer(): void {
  phaseTimer = new PhaseTimer();
}
