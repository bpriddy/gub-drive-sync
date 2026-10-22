/**
 * retryable.ts — which LLM failures are worth another attempt.
 *
 * Config-free (no env, no prisma) so callers outside the driver can
 * classify a failure and the unit suite can run it hermetically.
 */
import { ApiError } from '@google/genai';

/**
 * The statuses @google/genai itself treats as retryable
 * (DEFAULT_RETRY_HTTP_STATUS_CODES in 2.11): request timeout, rate limit,
 * server-side failure. Every other 4xx is permanent — retrying it only
 * burns time on the way to the same error.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * One attempt ran past its call type's deadline (the SDK aborted the fetch).
 * Retried like a 408: a stalled request is the transient case timeouts
 * exist for.
 */
export class LlmTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(`[gemini] request timed out after ${timeoutMs} ms`, options);
    this.name = 'LlmTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * An answer that stopped at the output token limit (finishReason
 * MAX_TOKENS). Its JSON is cut off mid-way, and thinking counts against the
 * limit, so a long think can leave no room for the answer. Treated as a
 * failed attempt: retried, and if every attempt is cut off the caller gets
 * a failure instead of a parse error on a fragment.
 */
export class LlmTruncatedError extends Error {
  readonly thoughtsTokens: number | null;
  readonly outputTokens: number | null;
  constructor(usage: { thoughtsTokens: number | null; outputTokens: number | null }) {
    super(
      `[gemini] answer cut off at the output token limit (thoughts ${usage.thoughtsTokens ?? '?'}, output ${usage.outputTokens ?? '?'})`,
    );
    this.name = 'LlmTruncatedError';
    this.thoughtsTokens = usage.thoughtsTokens;
    this.outputTokens = usage.outputTokens;
  }
}

export function isRetryableLlmError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof LlmTimeoutError) return true;
  if (err instanceof LlmTruncatedError) return true;
  // API-level errors carry a typed HTTP status (SDK-recommended handling).
  if (err instanceof ApiError) return isRetryableHttpStatus(err.status);
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Network-level failures never reach ApiError (they surface as fetch or
  // socket errors from the transport) — string-match those.
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('econnreset')) return true;
  if (msg.includes('etimedout')) return true;
  if (msg.includes('econnrefused')) return true;
  if (msg.includes('socket hang up')) return true;
  if (msg.includes('deadline exceeded')) return true;
  return false;
}
