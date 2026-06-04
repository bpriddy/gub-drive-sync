/**
 * progress.ts — TTY-gated human-readable scan progress.
 *
 * Sits alongside the structured pino logger. Pino is for production
 * observability (Cloud Logging structured JSON); this is for an operator
 * watching a scan stream in a local terminal.
 *
 * Gated on `process.stdout.isTTY`. In Cloud Run (no TTY) every method is
 * a no-op, so this never pollutes production logs. Production diagnosis
 * goes through `drive_scan_logs` (DB) and pino structured records.
 *
 * Per-file errors are summarized to ONE line here; the full error
 * context is already written to `drive_scan_logs.payload` by the same
 * call site. Operators query the DB for the deep dive.
 */

const ENABLED = process.stdout.isTTY === true;

// ── ANSI helpers (no chalk dep) ──────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

function c(color: string, s: string): string {
  return ENABLED ? `${color}${s}${RESET}` : s;
}

function write(line: string): void {
  if (!ENABLED) return;
  process.stdout.write(line + '\n');
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function rule(title: string): string {
  // 78-col width target; pad with horizontal lines.
  const head = `═══ ${title} `;
  const remaining = Math.max(3, 78 - head.length);
  return head + '═'.repeat(remaining);
}

/**
 * Build a JSON-safe object from any error value, suitable for stashing
 * in a Prisma `Json?` column.
 *
 * Why this exists: googleapis errors carry `.config`, `.response`, and
 * `.request` properties with circular references and non-serializable
 * function fields (e.g. `transformResponse`). A naive `{ ...err }`
 * spread blows up Prisma's JSON validation. Pick only the safe fields.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err == null) return { value: null };
  if (typeof err !== 'object') return { value: String(err) };
  const e = err as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    code?: unknown;
    status?: unknown;
    statusText?: unknown;
    errors?: unknown;
  };
  const out: Record<string, unknown> = {};
  if (typeof e.name === 'string') out.name = e.name;
  if (typeof e.message === 'string') out.message = e.message;
  if (typeof e.stack === 'string') out.stack = e.stack;
  if (typeof e.code === 'number' || typeof e.code === 'string') out.code = e.code;
  if (typeof e.status === 'number' || typeof e.status === 'string') out.status = e.status;
  if (typeof e.statusText === 'string') out.statusText = e.statusText;
  // googleapis structured errors: array of { reason, message, domain }
  if (Array.isArray(e.errors)) {
    out.errors = e.errors
      .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
      .map((x) => {
        const r = x as { reason?: unknown; message?: unknown; domain?: unknown };
        const item: Record<string, unknown> = {};
        if (typeof r.reason === 'string') item.reason = r.reason;
        if (typeof r.message === 'string') item.message = r.message;
        if (typeof r.domain === 'string') item.domain = r.domain;
        return item;
      });
  }
  return out;
}

/**
 * Best-effort short summary of an error.
 *
 * Three shapes of googleapis errors to handle:
 *
 *   (a) The "typed" shape from normal JSON endpoints:
 *         err.code = 403 (number), err.errors = [{ reason: 'forbidden' }]
 *
 *   (b) The "stream-response" shape — `files.get(alt=media)` and similar
 *       binary endpoints. The HTTP body never got parsed into typed
 *       fields. `err.message` is a stringified JSON like:
 *         '{ "error": { "code": 403, "message": "...", "errors": [...] } }'
 *
 *   (c) Plain Error or string.
 *
 * We try to recover (a)-equivalent fields from (b) by parsing the
 * message, then fall back to truncation.
 */
export function summarizeError(err: unknown, maxLen = 100): string {
  if (!err) return 'unknown error';
  if (typeof err !== 'object') return String(err).slice(0, maxLen);
  const e = err as {
    code?: number | string;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };

  let code: number | string | undefined = e.code;
  let message: string | undefined = e.message;
  let firstReason: string | undefined;
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    firstReason = e.errors[0]?.reason ?? e.errors[0]?.message;
  }

  // Shape (b): try to parse e.message as JSON and lift the nested fields.
  if (message && message.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(message) as {
        error?: {
          code?: number;
          message?: string;
          errors?: Array<{ reason?: string; message?: string }>;
        };
      };
      const inner = parsed.error;
      if (inner) {
        if (typeof inner.code === 'number') code = inner.code;
        if (typeof inner.message === 'string') message = inner.message;
        if (Array.isArray(inner.errors) && inner.errors.length > 0 && !firstReason) {
          firstReason = inner.errors[0]?.reason ?? inner.errors[0]?.message;
        }
      }
    } catch {
      // not JSON, leave as-is
    }
  }

  const parts: string[] = [];
  if (typeof code === 'number') parts.push(`HTTP ${code}`);
  else if (typeof code === 'string') parts.push(code);
  if (firstReason) {
    parts.push(`(${firstReason})`);
  } else if (message) {
    // Strip newlines so the line stays on one line; trim and truncate.
    const clean = message.replace(/\s+/g, ' ').trim();
    parts.push(clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean);
  }
  return parts.join(' ') || 'unknown error';
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface EntityScanStats {
  filesSeen: number;
  filesExtracted: number;
  filesSkipped: number;
  filesErrored: number;
  proposalsCreated: number;
  notesWritten: number;
  ambiguousWritten: number;
  /** Total wall time for this entity's scanEntity call, in ms. */
  durationMs: number;
}

export interface RunSummary {
  syncRunId: string;
  accountsScanned: number;
  campaignsScanned: number;
  proposalsCreated: number;
  errors: number;
  durationMs: number;
  paused: boolean;
}

export const progress = {
  /** Top banner at start of a Job execution. */
  start(label: string, syncRunId: string): void {
    write('');
    write(c(BOLD, rule(label)));
    write(c(GRAY, `  syncRunId: ${syncRunId}`));
  },

  /** Phase delimiter (Discovery / Accounts / Campaigns / Notify). */
  phase(name: string): void {
    write('');
    write(c(CYAN, rule(name)));
  },

  /** A diagnostic line under a phase header ("(skipped — env unset)"). */
  phaseNote(text: string): void {
    write(c(GRAY, `  (${text})`));
  },

  /** Before each per-entity scan: "→ Scanning account: Chevy". */
  entity(label: string): void {
    write('');
    write(c(BOLD, `→ Scanning ${label}`));
  },

  /** Per-file success after extraction + LLM interpretation. */
  file(name: string, extractor: string, sizeBytes: number | null, obsCount: number): void {
    const left = `  ${c(GREEN, '✓')} ${name}`;
    const sizePart = sizeBytes ? `${fmtBytes(sizeBytes)}, ` : '';
    const right = c(DIM, `${sizePart}${extractor}`) + '  ' + c(DIM, `${obsCount} obs`);
    write(`${left}  ${right}`);
  },

  /** Per-file skip (unsupported mime, too_large, empty, delta_unchanged). */
  fileSkip(name: string, reason: string, detail?: string | null): void {
    const tail = detail ? c(GRAY, `${reason} — ${detail}`) : c(GRAY, reason);
    write(`  ${c(YELLOW, '⊘')} ${name}  ${tail}`);
  },

  /** Per-file error. Short summary only; full payload is in drive_scan_logs. */
  fileError(name: string, errSummary: string): void {
    write(`  ${c(RED, '✗')} ${name}  ${c(RED, errSummary)}`);
  },

  /** Entity-level error — the scan itself threw before completing. */
  entityError(label: string, errSummary: string): void {
    write(`${c(RED, '✗')} ${label}: ${c(RED, errSummary)}`);
  },

  /** End of one entity's scan. */
  entityDone(label: string, stats: EntityScanStats): void {
    const headSym = stats.filesErrored > 0 ? c(YELLOW, '✓') : c(GREEN, '✓');
    const avg = stats.filesExtracted > 0
      ? ` (${fmtMs(Math.round(stats.durationMs / stats.filesExtracted))} avg/file)`
      : '';
    const pieces = [
      `${stats.filesSeen} files`,
      `${stats.proposalsCreated} proposals`,
    ];
    if (stats.notesWritten > 0) pieces.push(`${stats.notesWritten} notes`);
    if (stats.ambiguousWritten > 0) pieces.push(`${stats.ambiguousWritten} ambiguous`);
    if (stats.filesErrored > 0) pieces.push(c(RED, `${stats.filesErrored} errors`));
    write(`${headSym} ${label}: ${pieces.join(', ')}${c(DIM, avg)}`);
  },

  /** Notify phase result. */
  notify(ownersEmailed: number, orphansLogged: number, emailDriver: string): void {
    write(`  ${ownersEmailed} owner(s) emailed, ${orphansLogged} orphan(s) logged  ${c(DIM, `[${emailDriver}]`)}`);
  },

  /** Closing block at end of run. */
  summary(s: RunSummary): void {
    write('');
    const status = s.paused ? c(YELLOW, 'paused') : (s.errors > 0 ? c(YELLOW, 'complete (with errors)') : c(GREEN, 'complete'));
    write(c(BOLD, rule(`Drive sync ${status} (${fmtMs(s.durationMs)})`)));
    write(c(DIM, `  ${s.accountsScanned} account(s), ${s.campaignsScanned} campaign(s), ${s.proposalsCreated} proposals, ${s.errors} errors`));
    write('');
  },

  /** Generic info line for callers that don't fit a method above. */
  info(text: string): void {
    write(c(DIM, `  ${text}`));
  },
};
