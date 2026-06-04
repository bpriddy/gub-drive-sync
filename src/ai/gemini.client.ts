/**
 * gemini.client.ts — Gemini-backed LlmDriver with mock fallback.
 *
 * Driver selection:
 *   - GEMINI_API_KEY set → real Gemini via @google/generative-ai
 *   - unset             → MockLlmDriver returns a schema-shaped empty response
 *                         so the pipeline still runs end-to-end in dev.
 *
 * When a `responseSchema` is provided, we set responseMimeType=application/json
 * and Gemini guarantees the response conforms. The caller still runs its Zod
 * validation on top for type-narrowing + defense in depth.
 */

import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
  type Schema,
} from '@google/generative-ai';
import { config } from '../config';
import { logger } from '../logger';
import type { LlmCompletionRequest, LlmCompletionResult, LlmDriver } from './ai.types';

/**
 * Retry posture for Gemini calls.
 *
 * Transient failures (network blips, 5xx, 429 rate limits) shouldn't kill
 * a multi-hour scan over one bad moment. We retry up to MAX_ATTEMPTS=3
 * with exponential backoff. Non-retryable errors (4xx other than 429,
 * auth issues, malformed prompts) throw immediately — retrying those
 * just wastes time.
 *
 * Detection is heuristic: the GoogleGenerativeAI SDK wraps fetch errors
 * into `GoogleGenerativeAIError` with the underlying cause in the
 * message. We string-match on the most common transient patterns.
 */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000; // 1s → 3s → 9s (3^attempt)

function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('econnreset')) return true;
  if (msg.includes('etimedout')) return true;
  if (msg.includes('econnrefused')) return true;
  if (msg.includes('socket hang up')) return true;
  if (msg.includes('rate limit') || msg.includes('429')) return true;
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
    return true;
  }
  // Gemini-specific: "deadline exceeded", "internal" surface as retryable.
  if (msg.includes('deadline exceeded')) return true;
  if (msg.includes('internal error')) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GeminiLlmDriver implements LlmDriver {
  readonly name = 'gemini';
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const generationConfig: Record<string, unknown> = { temperature: req.temperature };
    if (req.responseSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = req.responseSchema;
    }
    const model = this.client.getGenerativeModel({
      model: req.model,
      generationConfig: generationConfig as never,
    });

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await model.generateContent(req.prompt);
        const text = res.response.text();
        if (attempt > 1) {
          logger.info(
            { model: req.model, tag: req.tag, attempt },
            '[gemini] generateContent succeeded after retry',
          );
        }
        return { text, driver: this.name, model: req.model, raw: res };
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
function emptyInstance(schema: Schema | ResponseSchema): unknown {
  switch (schema.type) {
    case SchemaType.ARRAY:
      return [];
    case SchemaType.OBJECT: {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of schema.required ?? []) {
        const child = props[key];
        if (child) out[key] = emptyInstance(child);
      }
      return out;
    }
    case SchemaType.STRING:
      return '';
    case SchemaType.NUMBER:
    case SchemaType.INTEGER:
      return 0;
    case SchemaType.BOOLEAN:
      return false;
    default:
      return null;
  }
}

function createDriver(): LlmDriver {
  if (!config.GEMINI_API_KEY) {
    logger.warn('[llm] GEMINI_API_KEY unset — using mock driver. LLM interpretation will return empty results.');
    return new MockLlmDriver();
  }
  return new GeminiLlmDriver(config.GEMINI_API_KEY);
}

export const defaultLlm: LlmDriver = createDriver();
