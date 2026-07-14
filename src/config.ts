/**
 * config.ts — env validation. Fail-fast at boot.
 *
 * Subset of GUB's env schema: only the variables this Job actually reads
 * (Drive tuning, Gemini, mail, bot-OAuth, self-trigger plumbing). Other
 * GUB variables — JWT keys, GOOGLE_CLIENT_ID, CORS, etc. — are not
 * needed: this Job has no HTTP surface, no auth issuance, no CORS.
 */
import { z } from 'zod';

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
  DRIVE_DELAY_BETWEEN_FILES_MS: z.string().default('500').transform(Number),
  // 300 MB default. Only enforced for BINARY downloads (PDF, DOCX, PPTX,
  // text/*) where we pull bytes into memory. Google-native files
  // (Docs/Sheets/Slides) are API-traversed and skip this cap entirely.
  // Note: a 300 MB binary requires meaningful runtime memory — the
  // Cloud Run Job's --memory should be >=1Gi (currently 1Gi; bump to
  // 2Gi if you start seeing OOM on the largest PDFs).
  DRIVE_MAX_FILE_SIZE_BYTES: z.string().default('314572800').transform(Number),
  DRIVE_PROPOSAL_TTL_DAYS: z.string().default('14').transform(Number),

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
   * Worker-pool concurrency for the per-entity distill+synth+write loop
   * inside processBatch. Each entity owns a discrete status_markdown blob
   * on its own row (one per account, one per campaign) — workers never
   * touch the same row, so parallel writes don't race. Default 8 is
   * "max safe" under the bumped Prisma pool (10) and Gemini 2.5 Pro's
   * paid-tier RPM cap (~1000). On a 16-entity day, ~40min sequential
   * synth → ~5min parallel.
   */
  SYNTH_CONCURRENCY: z.string().default('8').transform(Number),

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
    const errors = parsed.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Environment configuration invalid:\n${errors}`);
  }
  return parsed.data;
}

export const config = loadConfig();
