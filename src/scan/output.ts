// Part of the scan core (src/scan/) — mode-agnostic batch machinery shared
// by every driver (day-walk backfill today; the Activity forward driver next).
import { appendFileSync } from 'node:fs';

// ── Output ───────────────────────────────────────────────────────────────────

let outputFile: string | null = null;
/**
 * When non-null, every log() line is also pushed here (in addition to
 * stdout / outputFile). Used by `runBackfill`'s programmatic callers
 * (the watch mode) to capture output for persistence as
 * drive_backfill_requests.log_summary.
 */
let logCapture: string[] | null = null;
export function log(line = ''): void {
  process.stdout.write(line + '\n');
  if (outputFile) appendFileSync(outputFile, line + '\n');
  if (logCapture) logCapture.push(line);
}

export function rule(title: string): string {
  const head = `═══ ${title} `;
  const remaining = Math.max(3, 78 - head.length);
  return head + '═'.repeat(remaining);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}


/** Set the tee file for log() (CLI --output). Caller creates/truncates it. */
export function setOutputFile(path: string | null): void {
  outputFile = path;
}

/** Read/replace the capture buffer (runBackfill's scope guard swaps it). */
export function getLogCapture(): string[] | null {
  return logCapture;
}
export function setLogCapture(buf: string[] | null): void {
  logCapture = buf;
}
