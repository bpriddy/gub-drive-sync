/**
 * config.ts — env validation. Fail-fast at boot.
 *
 * Subset of GUB's env schema: only the variables this Job actually reads
 * (Drive tuning, Gemini, mail, bot-OAuth, self-trigger plumbing). Other
 * GUB variables — JWT keys, GOOGLE_CLIENT_ID, CORS, etc. — are not
 * needed: this Job has no HTTP surface, no auth issuance, no CORS.
 */
import { z } from 'zod';

/** A per-request timeout in ms; `0` disables it (the pre-timeout behaviour). */
const timeoutMs = (fallback: string) =>
  z.string().default(fallback).transform(Number).pipe(z.number().int().min(0));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // ── Bot-OAuth (Drive API) ────────────────────────────────────────────────
  // Required at runtime — without these, buildBotOAuthClient throws a clear
  // BotCredentialsConfigError. Optional in the schema so `npm run dev` can
  // still boot for non-Drive-touching tasks.
  GUB_BOT_OAUTH_CLIENT_ID: z.string().optional(),
  GUB_BOT_OAUTH_CLIENT_SECRET: z.string().optional(),

  // ── Drive scan tuning ────────────────────────────────────────────────────
  DRIVE_ROOT_FOLDER_ID: z.string().optional(),
  DRIVE_DELAY_BETWEEN_ACCOUNTS_MS: z.string().default('5000').transform(Number),
  DRIVE_DELAY_BETWEEN_CAMPAIGNS_MS: z.string().default('2000').transform(Number),
  // 300 MB default. Only enforced for BINARY downloads (PDF, DOCX, PPTX,
  // text/*) where we pull bytes into memory. Google-native files
  // (Docs/Sheets/Slides) are API-traversed and skip this cap entirely.
  // Note: a 300 MB binary requires meaningful runtime memory — the
  // Cloud Run Job's --memory should be >=1Gi (currently 1Gi; bump to
  // 2Gi if you start seeing OOM on the largest PDFs).
  DRIVE_MAX_FILE_SIZE_BYTES: z.string().default('314572800').transform(Number),
  // In-flight budget for BINARY downloads. A download is buffered whole and its
  // parser then builds structures next to the buffer, so N workers x up to
  // DRIVE_MAX_FILE_SIZE_BYTES can exceed the job's memory. The metadata sizes
  // of the downloads in flight (fetch + parse) sum to at most
  // DOWNLOAD_INFLIGHT_BYTES; a file at or above DOWNLOAD_HEAVY_BYTES, or of
  // unknown size, runs alone. 600 MiB / 50 MiB: a transfer briefly holds ~2x its
  // size (the chunks plus the concatenated Buffer), which still fits the 2Gi
  // job. No flag: the default is the bound, and it only limits concurrency.
  // HEAVY must not exceed INFLIGHT (checked in loadConfig).
  DOWNLOAD_INFLIGHT_BYTES: z
    .string()
    .default('629145600')
    .transform(Number)
    .pipe(z.number().int().safe().min(1)),
  DOWNLOAD_HEAVY_BYTES: z
    .string()
    .default('52428800')
    .transform(Number)
    .pipe(z.number().int().safe().min(1)),
  // Google-native files (Docs/Sheets/Slides) have no byte size to check before
  // the read, so their cap is on the extracted TEXT: a file whose walked text is
  // longer than this is skipped (skip_reason 'too_many_chars'), not truncated.
  // 2M characters is far above real documents (an 825k-character sheet has been
  // seen). It bounds what goes on to hashing, the LLM stage and the DB; the API
  // response itself is already in memory by the time the walker returns.
  NATIVE_MAX_CHARS: z
    .string()
    .default('2000000')
    .transform(Number)
    .pipe(z.number().int().safe().min(1)),
  DRIVE_PROPOSAL_TTL_DAYS: z.string().default('14').transform(Number),
  /**
   * drive_file_snapshots rows (the Drive name index) allowed to fail per
   * batch before the run itself fails. 0 = any failed row fails the run, so
   * the queue retries it and a DB/schema problem cannot quietly empty the
   * index again. Raising it is a stop-gap while that problem is fixed: the
   * files over the limit stay stale in the index until they change again.
   */
  SNAPSHOT_WRITE_FAILURE_LIMIT: z
    .string()
    .default('0')
    .transform(Number)
    .pipe(z.number().int().min(0)),

  // ── AI / Gemini ──────────────────────────────────────────────────────────
  GEMINI_API_KEY: z.string().optional(),
  /**
   * Route Gemini calls through the Gemini Enterprise Agent Platform (the
   * GCP-project surface: SA/ADC auth, project quotas + billing, enterprise
   * data terms) instead of the consumer Developer API. Requires
   * GCP_PROJECT_ID; auth is ADC (job SA in Cloud Run, gcloud ADC locally).
   * 'false' falls back to the consumer API key path.
   */
  GEMINI_USE_ENTERPRISE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Model location for the enterprise surface. gemini-3.5-flash is served
   * from the GLOBAL endpoint only — not a region. Distinct from GCP_REGION
   * (where our infra lives).
   */
  GEMINI_LOCATION: z.string().default('global'),
  GEMINI_MAX_INPUT_CHARS: z.string().default('40000').transform(Number),
  /**
   * Content-aware skips in the scan core. `off` (the default) is the behaviour
   * before them. `on`:
   *   - Drive is asked for the files' content markers (drive/client.ts fileFields);
   *   - a trashed file is skipped (skip_reason 'trashed');
   *   - snapshot rows carry the versioned content hash (src/scan/content-gate.ts);
   *   - the forward run skips interpret and idea extraction for a file whose
   *     content hash matches its newest committed extracted row
   *     (skip_reason 'content_unchanged'; docs/drive-file-index.md).
   */
  SKIP_UNCHANGED_CONTENT: z.enum(['off', 'on']).default('off'),
  /**
   * Worker-pool concurrency for the per-entity distill+synth+write loop
   * inside processBatch. Each entity owns a discrete status_markdown blob
   * on its own row (one per account, one per campaign) — workers never
   * touch the same row, so parallel writes don't race. Default 8 is
   * "max safe" under the bumped Prisma pool (10) and Gemini 2.5 Pro's
   * paid-tier RPM cap (~1000). On a 16-entity day, ~40min sequential
   * synth → ~5min parallel.
   */
  SYNTH_CONCURRENCY: z.string().default('8').transform(Number),

  // ── Request timeouts (ms, per attempt; 0 = none) ────────────────────────
  // A stalled call used to hang until undici's 300 s fetch default (Gemini)
  // or forever (googleapis). Each Gemini attempt aborts at its call type's
  // deadline and is retried like a 408. Distill calls of ~185 s are
  // legitimate; folder classify can run past 300 s.
  GEMINI_TIMEOUT_INTERPRET_MS: timeoutMs('120000'),
  GEMINI_TIMEOUT_DISTILL_MS: timeoutMs('240000'),
  GEMINI_TIMEOUT_CLASSIFY_MS: timeoutMs('420000'),
  /** Every other Gemini call (synthesis, ideas, asset folders, merges…). */
  GEMINI_TIMEOUT_DEFAULT_MS: timeoutMs('300000'),
  /** Drive / Docs / Slides / Sheets / Activity / People reads. */
  DRIVE_READ_TIMEOUT_MS: timeoutMs('60000'),
  /** Binary downloads (files.get alt=media), headers + body. */
  DRIVE_MEDIA_TIMEOUT_MS: timeoutMs('300000'),

  // ── Notify URLs ──────────────────────────────────────────────────────────
  GUB_ADMIN_BASE_URL: z.string().url().default('http://localhost:5173'),
  GUB_REVIEW_BASE_URL: z.string().url().optional(),

  // ── Mail ─────────────────────────────────────────────────────────────────
  MAIL_DRIVER: z.enum(['console', 'mailgun']).default('console'),
  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_DOMAIN: z.string().optional(),
  MAILGUN_REGION: z.enum(['us', 'eu']).default('us'),
  MAIL_FROM_ADDRESS: z.string().email().optional(),
  MAIL_FROM_NAME: z.string().default('GUB'),

  // ── Self-trigger (chunked-sync continuation) ─────────────────────────────
  // Required for the `continue` mode to be reachable from the runner. If
  // these are unset, scheduleContinuation() logs and gives up — the
  // paused sync_run will be reaped by the next entry's reaper after
  // PAUSED_THRESHOLD_MINUTES, surfacing the misconfiguration.
  GCP_PROJECT_ID: z.string().optional(),
  GCP_REGION: z.string().optional(),
  DRIVE_SYNC_JOB_NAME: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(): Config {
  // Treat empty strings as "not set" so the same schema works whether a
  // var is omitted or left blank in .env. (Same trick as GUB.)
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && v !== '') cleaned[k] = v;
  }
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const errors = parsed.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Environment configuration invalid:\n${errors}`);
  }
  // Cross-field: a file below the heavy threshold has to fit in the in-flight
  // budget, or it could never be admitted. Fail at boot rather than hang on
  // the first download.
  const { DOWNLOAD_HEAVY_BYTES: heavy, DOWNLOAD_INFLIGHT_BYTES: inflight } = parsed.data;
  if (heavy > inflight) {
    throw new Error(
      `Environment configuration invalid:\n  DOWNLOAD_HEAVY_BYTES: must not exceed DOWNLOAD_INFLIGHT_BYTES (${heavy} > ${inflight})`,
    );
  }
  return parsed.data;
}

export const config = loadConfig();
