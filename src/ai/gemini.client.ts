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
import { jitteredDelayMs } from '../backoff';
import { isRetryableLlmError, LlmTimeoutError } from './retryable';
import { raiseFetchTimeouts, requiredFetchTimeoutMs } from './fetch-timeouts';
import { recordLlmUsage } from './usage-tally';
import { thinkingLevelFor } from './thinking';
import type { LlmCompletionRequest, LlmCompletionResult, LlmDriver, LlmUsage } from './ai.types';

/**
 * Retry posture for Gemini calls.
 *
 * Transient failures (network blips, 408, 429 rate limits, 5xx) shouldn't
 * kill a multi-hour scan over one bad moment. We retry up to MAX_ATTEMPTS=3
 * with jittered exponential backoff. Non-retryable errors (other 4xx, auth
 * issues, malformed prompts) throw immediately — retrying those just wastes
 * time. Classification lives in ./retryable (isRetryableLlmError).
 */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000; // nominal 1s → 3s (3^attempt), jittered ×[0.5, 1.5)

/** Longest error text carried on the WARN line — enough for status + reason. */
const WARN_ERR_MAX_CHARS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GeminiDriverOptions {
  /** Backoff sleep — injectable so the unit suite doesn't wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiLlmDriver implements LlmDriver {
  readonly name: string;
  private client: GoogleGenAI;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    init: { project: string; location: string } | { apiKey: string },
    opts: GeminiDriverOptions = {},
  ) {
    this.sleep = opts.sleep ?? sleep;
    // NO retryOptions: OUR loop below owns retries (logging + backoff).
    // With retryOptions set — even {attempts: 1} — @google/genai 2.11 routes
    // fetch through p-retry and throws a plain Error("Retryable HTTP Error:
    // <statusText>") for 408/429/5xx and "Non-retryable exception …" for
    // the rest: no ApiError, no status, no response body. Without it the
    // SDK makes exactly one fetch per call (no built-in retry) and throws a
    // typed ApiError carrying the status and the server's error message.
    const httpOptions = {};
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
    // Per-attempt deadline. httpOptions.timeout makes the SDK abort the
    // fetch and send X-Server-Timeout so the server gives up too.
    const timeoutMs = req.timeoutMs ?? config.GEMINI_TIMEOUT_DEFAULT_MS;
    // A caller's own thinking setting wins. Otherwise GEMINI_THINKING_BY_TAG
    // decides, and a tag it does not map sends no thinking parameter (#69).
    const thinkingLevel =
      req.thinkingLevel ??
      (req.thinkingBudget === undefined
        ? thinkingLevelFor(req.tag, config.GEMINI_THINKING_BY_TAG ?? {})
        : undefined);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const attemptStartedAt = Date.now();
      try {
        const res = await this.client.models.generateContent({
          model: req.model,
          contents: req.prompt,
          config: {
            ...(timeoutMs > 0 ? { httpOptions: { timeout: timeoutMs } } : {}),
            temperature: req.temperature,
            ...(req.responseSchema
              ? { responseMimeType: 'application/json', responseSchema: req.responseSchema }
              : {}),
            ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
            ...(req.thinkingBudget !== undefined
              ? { thinkingConfig: { thinkingBudget: req.thinkingBudget } }
              : thinkingLevel !== undefined
                ? { thinkingConfig: { thinkingLevel: thinkingLevel as ThinkingLevel } }
                : {}),
          },
        });
        const text = res.text ?? '';
        const finishReason = res.candidates?.[0]?.finishReason ?? null;
        const u = res.usageMetadata;
        const usage: LlmUsage | undefined = u
          ? {
              promptTokens: u.promptTokenCount ?? null,
              thoughtsTokens: u.thoughtsTokenCount ?? null,
              outputTokens: u.candidatesTokenCount ?? null,
              totalTokens: u.totalTokenCount ?? null,
              cachedContentTokens: u.cachedContentTokenCount ?? null,
            }
          : undefined;
        // Every attempt is billed, so every attempt counts toward the
        // run's per-tag totals (printed in the run summary).
        recordLlmUsage(req.tag, usage, finishReason);
        if (u && usage) {
          // INFO since bpriddy/gub-drive-sync#69: tokens per call type,
          // thoughts included, are the input to the thinking-level choice.
          // The provider's own field names ride alongside the older keys.
          logger.info(
            {
              model: req.model,
              tag: req.tag,
              ...usage,
              promptTokenCount: u.promptTokenCount ?? null,
              candidatesTokenCount: u.candidatesTokenCount ?? null,
              thoughtsTokenCount: u.thoughtsTokenCount ?? null,
              cachedContentTokenCount: u.cachedContentTokenCount ?? null,
              finishReason,
            },
            '[gemini] usage',
          );
        }
        // One INFO line per completed call. finishReason tells a clean STOP
        // from a MAX_TOKENS truncation or a SAFETY block — the cases that
        // later surface only as a JSON parse failure in the caller.
        logger.info(
          {
            model: req.model,
            tag: req.tag,
            attempt,
            finishReason,
            blockReason: res.promptFeedback?.blockReason ?? null,
            thinkingLevel: thinkingLevel ?? null,
            durationMs: Date.now() - attemptStartedAt,
            promptTokens: usage?.promptTokens ?? null,
            thoughtsTokens: usage?.thoughtsTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
          },
          '[gemini] generateContent finished',
        );
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
          finishReason,
        };
      } catch (caught) {
        // The SDK's deadline surfaces as fetch's bare AbortError ("This
        // operation was aborted"); name it so logs and the retry say why.
        const err =
          timeoutMs > 0 && caught instanceof Error && caught.name === 'AbortError'
            ? new LlmTimeoutError(timeoutMs, { cause: caught })
            : caught;
        lastErr = err;
        const retryable = isRetryableLlmError(err);
        const willRetry = retryable && attempt < MAX_ATTEMPTS;
        // Full error object stays at debug: callers (distill, interpret,
        // etc.) handle the user-facing error display via progress.* +
        // drive_scan_logs. Successful retries log at info above so we know
        // it self-healed.
        logger.debug(
          { err, model: req.model, tag: req.tag, attempt, retryable, willRetry },
          '[gemini] generateContent failed',
        );
        const backoffMs = willRetry
          ? jitteredDelayMs(BASE_BACKOFF_MS * Math.pow(3, attempt - 1))
          : null;
        // Every failed attempt is visible at the default level — a 429
        // storm that self-heals and one that loses a bucket must both show.
        logger.warn(
          {
            model: req.model,
            tag: req.tag,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            status: err instanceof ApiError ? err.status : null,
            retryable,
            willRetry,
            backoffMs,
            error: (err instanceof Error ? err.message : String(err)).slice(0, WARN_ERR_MAX_CHARS),
          },
          '[gemini] generateContent attempt failed',
        );
        if (backoffMs === null) break;
        await this.sleep(backoffMs);
      }
    }
    throw lastErr;
  }
}

class MockLlmDriver implements LlmDriver {
  readonly name = 'mock';

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    logger.info({ tag: req.tag, model: req.model }, '[llm:mock] returning stub response');
    const text = req.responseSchema ? JSON.stringify(emptyInstance(req.responseSchema)) : '[]';
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

/**
 * Lift Node's fetch limits above the longest Gemini deadline (see
 * ./fetch-timeouts). Real drivers only; the mock never fetches.
 */
function allowConfiguredDeadlines(): void {
  const needed = requiredFetchTimeoutMs([
    config.GEMINI_TIMEOUT_INTERPRET_MS,
    config.GEMINI_TIMEOUT_DISTILL_MS,
    config.GEMINI_TIMEOUT_CLASSIFY_MS,
    config.GEMINI_TIMEOUT_DEFAULT_MS,
  ]);
  if (needed === null) return;
  raiseFetchTimeouts(needed);
  logger.info(
    { headersTimeoutMs: needed, bodyTimeoutMs: needed },
    '[llm] fetch dispatcher timeouts raised',
  );
}

function logThinkingLevels(): void {
  const levels = config.GEMINI_THINKING_BY_TAG;
  if (Object.keys(levels).length > 0) {
    logger.info({ levels }, '[llm] thinking levels by call tag');
  }
}

function createDriver(): LlmDriver {
  if (config.GEMINI_USE_ENTERPRISE && config.GCP_PROJECT_ID) {
    allowConfiguredDeadlines();
    logThinkingLevels();
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
    allowConfiguredDeadlines();
    logThinkingLevels();
    return new GeminiLlmDriver({ apiKey: config.GEMINI_API_KEY });
  }
  logger.warn(
    '[llm] no Gemini config (GEMINI_USE_ENTERPRISE+GCP_PROJECT_ID or GEMINI_API_KEY) — using mock driver. LLM interpretation will return empty results.',
  );
  return new MockLlmDriver();
}

export const defaultLlm: LlmDriver = createDriver();
