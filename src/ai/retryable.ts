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

export function isRetryableLlmError(err: unknown): boolean {
  if (!err) return false;
  // API-level errors carry a typed HTTP status (SDK-recommended handling).
  if (err instanceof ApiError) return isRetryableHttpStatus(err.status);
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // With httpOptions.retryOptions set, the SDK's retry wrapper (p-retry
  // around fetch) never builds an ApiError: a retryable status is thrown as
  // a plain Error carrying only the statusText, which can be empty. The
  // driver no longer sets retryOptions, but the SDK's behaviour is one
  // config line away, so the shape is matched here too.
  if (msg.startsWith('retryable http error')) return true;
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
