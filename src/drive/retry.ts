// Part of the Drive transport layer — deliberately free of config/prisma
// imports so the unit suite can exercise it without an environment (the CI
// contract is "hermetic, no DB needed"; src/config.ts throws at import time
// when DATABASE_URL is absent).
//
// A DIFFERENT concern from the rate limiter's. The limiter exists to pace
// calls so quota is never approached, and the retry inside it defends that
// contract — it re-tries the rate-limit that slipped past the spacing. 5xx
// responses and dropped sockets have nothing to do with quota, so they don't
// belong in a class named for rate limiting.
//
// Composition order matters: withTransientRetry WRAPS driveLimiter.run, never
// the reverse. The limiter serializes on chainTail and its retry sleeps inside
// the held slot, so a retry nested INSIDE .run() would block every other Drive
// call in the process while it waited. Wrapping means each attempt re-enters
// the queue and gets paced like any other call.

import { jitteredDelayMs } from '../backoff';
import { logger } from '../logger';

/**
 * Transport-level faults worth another attempt: 5xx from Google, and the
 * socket-level errors that show up on flaky networks.
 *
 * Deliberately NOT included:
 *   - 401 — a credential problem wanting a token refresh (google-auth-library
 *     does that itself), not something a sleep fixes. Retrying a genuine auth
 *     failure just burns time on the way to the same error.
 *   - 403/429 — owned by isRateLimitError (retryable, inside the limiter) and
 *     isDrivePermissionError (permanent). See their docstrings.
 */
export function isTransientTransportError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: number | string;
    status?: number;
    response?: { status?: number };
    message?: string;
    error?: { type?: string };
  };
  // A request that ran past its gaxios `timeout` (node-fetch FetchError,
  // wrapped by gaxios with no response): a stall, not a refusal.
  if (e.error?.type === 'request-timeout' || e.error?.type === 'body-timeout') return true;
  const numericCode = typeof e.code === 'string' ? Number(e.code) : e.code;
  const status =
    (Number.isFinite(numericCode) ? (numericCode as number) : undefined) ??
    e.status ??
    e.response?.status;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;

  const syscall = typeof e.code === 'string' ? e.code : '';
  if (
    syscall === 'ECONNRESET' ||
    syscall === 'ETIMEDOUT' ||
    syscall === 'ECONNREFUSED' ||
    syscall === 'ENETUNREACH' ||
    syscall === 'EAI_AGAIN' ||
    syscall === 'EPIPE'
  ) {
    return true;
  }
  return (
    typeof e.message === 'string' && /socket hang up|network socket disconnected/i.test(e.message)
  );
}

/**
 * A request this Job aborted at its own deadline. `code: 'ETIMEDOUT'` puts
 * it in the transient class (isTransientTransportError) on purpose.
 */
export class RequestTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * Retry a Drive call through a transient transport fault. 3 attempts,
 * 1s → 2s → 4s — roughly 7s of effort, enough to ride out a blip without
 * inflating a scan that touches hundreds of files.
 *
 * Wrap driveLimiter.run(...), not the other way round:
 *   withTransientRetry(() => driveLimiter.run(() => client.files.get(...)))
 */
export async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientTransportError(err) || attempt === MAX_ATTEMPTS) throw err;
      // Nominal 1 s → 2 s, jittered so parallel workers don't retry in step.
      const backoffMs = jitteredDelayMs(1000 * Math.pow(2, attempt - 1));
      logger.warn(
        { attempt, MAX_ATTEMPTS, backoffMs, err: err instanceof Error ? err.message : String(err) },
        '[drive.retry] transient transport fault — retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw new Error('withTransientRetry: exhausted without result');
}

/** 403 reasons that mean "rate-limited, try again". */
const RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'quotaExceeded']);

type ReasonList = Array<{ reason?: string } | null | undefined>;

/**
 * Drive/Workspace rate-limit signal — back off and try again:
 *   - 429, whatever its body says (newer APIs answer RESOURCE_EXHAUSTED
 *     with no `errors[].reason` at all);
 *   - 403 carrying a rate-limit reason.
 * Other 403s (auth, permissions) are NOT retryable and should propagate
 * immediately.
 *
 * Reasons are read wherever googleapis left them: `errors` on the error,
 * the parsed body, or — for `responseType: 'stream'` calls (media
 * downloads) — the raw JSON text gaxios read off the stream, where neither
 * `code` nor `errors` is set. Missing that last shape made a rate-limited
 * download look like a permission error (see isDrivePermissionError).
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: number | string;
    status?: number;
    errors?: ReasonList;
    response?: { status?: number; data?: unknown };
  };
  const code =
    typeof e.code === 'number'
      ? e.code
      : typeof e.code === 'string' && /^\d+$/.test(e.code)
        ? Number(e.code)
        : undefined;
  const status = code ?? e.status ?? e.response?.status;
  if (status === 429) return true;
  if (status !== 403) return false;
  return reasonsOf(e).some((r) => RATE_LIMIT_REASONS.has(r));
}

function reasonsOf(e: { errors?: ReasonList; response?: { data?: unknown } }): string[] {
  let body = e.response?.data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }
  const bodyErrors = (body as { error?: { errors?: ReasonList } } | undefined)?.error?.errors;
  return [...(e.errors ?? []), ...(bodyErrors ?? [])].map((x) => x?.reason ?? '');
}
