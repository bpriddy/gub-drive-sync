/**
 * gemini.client.ts — Gemini-backed LlmDriver with mock fallback.
 *
 * Driver selection:
 *   - GEMINI_API_KEY set → real Gemini via @google/genai (the supported SDK;
 *     @google/generative-ai is deprecated and was migrated off 2026-07-14)
 *   - unset             → MockLlmDriver returns a schema-shaped empty response
 *                         so the pipeline still runs end-to-end in dev.
 *
 * When a `responseSchema` is provided, we set responseMimeType=application/json
 * and Gemini guarantees the response conforms. The caller still runs its Zod
 * validation on top for type-narrowing + defense in depth.
 *
 * The new SDK exposes two things the old one couldn't:
 *   - thinkingConfig — callers may control reasoning via
 *     LlmCompletionRequest.thinkingLevel (the 3-series knob per the SDK's
 *     recommended practice: MINIMAL/LOW/MEDIUM/HIGH) or thinkingBudget (the
 *     2.5-series token cap; 0 disables). Latency levers; tune empirically —
 *     too little thinking can degrade extraction quality.
 *   - usageMetadata — prompt/thoughts/output token counts, returned on every
 *     completion (LlmCompletionResult.usage) and logged at debug, so latency
 *     work is measured rather than guessed.
 */

import { ApiError, GoogleGenAI, ThinkingLevel, Type, type Schema } from '@google/genai';
import { config } from '../config';
import { logger } from '../logger';
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmDriver,
  LlmUsage,
} from './ai.types';

/**
 * Retry posture for Gemini calls.
 *
 * Transient failures (network blips, 5xx, 429 rate limits) shouldn't kill
 * a multi-hour scan over one bad moment. We retry up to MAX_ATTEMPTS=3
 * with exponential backoff. Non-retryable errors (4xx other than 429,
 * auth issues, malformed prompts) throw immediately — retrying those
 * just wastes time.
 *
 * Detection: API-level errors are typed (ApiError.status — the SDK's
 * recommended handling); network-level transport errors never reach
 * ApiError, so those are string-matched.
 */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000; // 1s → 3s → 9s (3^attempt)

function isRetryable(err: unknown): boolean {
  if (!err) return false;
  // API-level errors carry a typed HTTP status (SDK-recommended handling):
  // retry rate limits + server-side failures, never other 4xx.
  if (err instanceof ApiError) {
    return err.status === 429 || (err.status >= 500 && err.status <= 599);
  }
  // Network-level failures never reach ApiError (they surface as fetch/socket
  // errors from the transport) — string-match those.
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('econnreset')) return true;
  if (msg.includes('etimedout')) return true;
  if (msg.includes('econnrefused')) return true;
  if (msg.includes('socket hang up')) return true;
  if (msg.includes('deadline exceeded')) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GeminiLlmDriver implements LlmDriver {
  readonly name: string;
  private client: GoogleGenAI;

  constructor(init: { project: string; location: string } | { apiKey: string }) {
    // retryOptions.attempts=1: OUR loop below owns retries (logging +
    // backoff); pinning the SDK's built-in retry off prevents the two
    // from stacking (SDK default is 5 attempts when retryOptions is set,
    // and unspecified behavior otherwise — explicit is deterministic).
    const httpOptions = { retryOptions: { attempts: 1 } };
    if ('project' in init) {
      // Gemini Enterprise Agent Platform: auth via ADC (the Cloud Run job's
      // service account in deploy; gcloud ADC locally) — no API key. The
      // location must be 'global' for gemini-3.5-flash (global-endpoint-only).
      this.name = 'gemini-enterprise';
      this.client = new GoogleGenAI({
        enterprise: true,
        project: init.project,
        location: init.location,
        httpOptions,
      });
    } else {
      this.name = 'gemini';
      this.client = new GoogleGenAI({ apiKey: init.apiKey, httpOptions });
    }
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.client.models.generateContent({
          model: req.model,
          contents: req.prompt,
          config: {
            temperature: req.temperature,
            ...(req.responseSchema
              ? { responseMimeType: 'application/json', responseSchema: req.responseSchema }
              : {}),
            ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
            ...(req.thinkingBudget !== undefined
              ? { thinkingConfig: { thinkingBudget: req.thinkingBudget } }
              : req.thinkingLevel !== undefined
                ? { thinkingConfig: { thinkingLevel: req.thinkingLevel as ThinkingLevel } }
                : {}),
          },
        });
        const text = res.text ?? '';
        const u = res.usageMetadata;
        const usage: LlmUsage | undefined = u
          ? {
              promptTokens: u.promptTokenCount ?? null,
              thoughtsTokens: u.thoughtsTokenCount ?? null,
              outputTokens: u.candidatesTokenCount ?? null,
              totalTokens: u.totalTokenCount ?? null,
            }
          : undefined;
        if (usage) {
          logger.debug(
            { model: req.model, tag: req.tag, ...usage },
            '[gemini] usage',
          );
        }
        if (attempt > 1) {
          logger.info(
            { model: req.model, tag: req.tag, attempt },
            '[gemini] generateContent succeeded after retry',
          );
        }
        return {
          text,
          driver: this.name,
          model: req.model,
          raw: res,
          ...(usage ? { usage } : {}),
        };
      } catch (err) {
        lastErr = err;
        const retryable = isRetryable(err);
        const willRetry = retryable && attempt < MAX_ATTEMPTS;
        // Demoted to debug: callers (distill, interpret, etc.) handle the
        // user-facing error display via progress.* + drive_scan_logs.
        // Successful retries log at info above so we know it self-healed.
        logger.debug(
          { err, model: req.model, tag: req.tag, attempt, retryable, willRetry },
          '[gemini] generateContent failed',
        );
        if (!willRetry) break;
        // Exponential backoff: 1s, 3s, 9s.
        await sleep(BASE_BACKOFF_MS * Math.pow(3, attempt - 1));
      }
    }
    throw lastErr;
  }
}

class MockLlmDriver implements LlmDriver {
  readonly name = 'mock';

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    logger.info({ tag: req.tag, model: req.model }, '[llm:mock] returning stub response');
    const text = req.responseSchema
      ? JSON.stringify(emptyInstance(req.responseSchema))
      : '[]';
    return { text, driver: this.name, model: req.model };
  }
}

/**
 * Build a minimally-valid instance of a responseSchema so mock responses
 * parse cleanly against caller Zod validators.
 */
function emptyInstance(schema: Schema): unknown {
  switch (schema.type) {
    case Type.ARRAY:
      return [];
    case Type.OBJECT: {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of schema.required ?? []) {
        const child = props[key];
        if (child) out[key] = emptyInstance(child);
      }
      return out;
    }
    case Type.STRING:
      return '';
    case Type.NUMBER:
    case Type.INTEGER:
      return 0;
    case Type.BOOLEAN:
      return false;
    default:
      return null;
  }
}

function createDriver(): LlmDriver {
  if (config.GEMINI_USE_ENTERPRISE && config.GCP_PROJECT_ID) {
    logger.info(
      { project: config.GCP_PROJECT_ID, location: config.GEMINI_LOCATION },
      '[llm] Gemini Enterprise Agent Platform (ADC auth)',
    );
    return new GeminiLlmDriver({
      project: config.GCP_PROJECT_ID,
      location: config.GEMINI_LOCATION,
    });
  }
  if (config.GEMINI_API_KEY) {
    return new GeminiLlmDriver({ apiKey: config.GEMINI_API_KEY });
  }
  logger.warn(
    '[llm] no Gemini config (GEMINI_USE_ENTERPRISE+GCP_PROJECT_ID or GEMINI_API_KEY) — using mock driver. LLM interpretation will return empty results.',
  );
  return new MockLlmDriver();
}

export const defaultLlm: LlmDriver = createDriver();
