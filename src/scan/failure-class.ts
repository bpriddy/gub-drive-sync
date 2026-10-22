// Part of the scan core (src/scan/) — which failures a re-run of the same
// window can recover. Config-free so the unit suite runs it hermetically.
import { isRetryableLlmError, LlmTruncatedError } from '../ai/retryable';
import { isRateLimitError, isTransientTransportError } from '../drive/retry';

/**
 * Prisma error codes for a lost or saturated connection, a timeout, or a
 * write conflict — the DB was unavailable, not the data wrong.
 */
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);

/**
 * True when running the same window again later would very likely succeed:
 * a rate limit, 408/5xx, a timeout, a dropped connection — after the call's
 * own retries were spent. False for a failure every re-run would repeat (a
 * corrupt file, a permission error, a malformed model response): holding
 * the cursor on those would stall the account forever, so they stay
 * counted-and-dropped.
 */
export function isTransientFailure(err: unknown): boolean {
  // An answer still cut off at the output limit after the driver's own
  // retries is a property of the prompt, not of the moment: a re-run of
  // the window would hit it again and hold the cursor every day. Counted
  // and dropped, as the parse failure it used to surface as was.
  if (err instanceof LlmTruncatedError) return false;
  if (isRetryableLlmError(err)) return true;
  if (isRateLimitError(err) || isTransientTransportError(err)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_PRISMA_CODES.has(code);
}
