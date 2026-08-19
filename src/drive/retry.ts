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
  };
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
  return typeof e.message === 'string' && /socket hang up|network socket disconnected/i.test(e.message);
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
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
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
