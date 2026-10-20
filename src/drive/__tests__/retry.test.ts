import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRateLimitError, isTransientTransportError, withTransientRetry } from '../retry';

describe('isTransientTransportError', () => {
  it('accepts 5xx from Google, however the status is shaped', () => {
    expect(isTransientTransportError({ code: 500 })).toBe(true);
    expect(isTransientTransportError({ code: '502' })).toBe(true);
    expect(isTransientTransportError({ status: 503 })).toBe(true);
    expect(isTransientTransportError({ response: { status: 504 } })).toBe(true);
  });

  it('accepts socket-level faults', () => {
    expect(isTransientTransportError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientTransportError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientTransportError({ code: 'EAI_AGAIN' })).toBe(true);
    expect(isTransientTransportError(new Error('socket hang up'))).toBe(true);
  });

  it('rejects the classes other handlers own', () => {
    // 401 wants a token refresh, not a sleep.
    expect(isTransientTransportError({ code: 401 })).toBe(false);
    // 403 belongs to isRateLimitError (retryable, in the limiter) or
    // isDrivePermissionError (permanent).
    expect(isTransientTransportError({ code: 403 })).toBe(false);
    // 404 is handled by getFileMetadata returning null.
    expect(isTransientTransportError({ code: 404 })).toBe(false);
    expect(isTransientTransportError(null)).toBe(false);
    expect(isTransientTransportError('boom')).toBe(false);
  });
});

describe('withTransientRetry', () => {
  // Backoff is jittered ×(0.5 + random); 0.5 pins it to the nominal 1 s → 2 s.
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the first success without waiting', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withTransientRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries through a transient fault and succeeds', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce({ code: 503 }).mockResolvedValue('ok');
      const promise = withTransientRetry(fn);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after 3 attempts and propagates — the file is then lost, not retried forever', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValue({ code: 500 });
      const promise = withTransientRetry(fn);
      const assertion = expect(promise).rejects.toEqual({ code: 500 });
      await vi.advanceTimersByTimeAsync(1000 + 2000);
      await assertion;
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a permission error — that is not a transport fault', async () => {
    const fn = vi.fn().mockRejectedValue({ code: 403 });
    await expect(withTransientRetry(fn)).rejects.toEqual({ code: 403 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('jitters the backoff instead of retrying on a fixed beat', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // top of the range: 1 s × 1.49
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce({ code: 503 }).mockResolvedValue('ok');
      const promise = withTransientRetry(fn);
      await vi.advanceTimersByTimeAsync(1489);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isRateLimitError', () => {
  it('treats any 429 as a back-off signal, reason or not', () => {
    expect(isRateLimitError({ code: 429 })).toBe(true);
    expect(isRateLimitError({ status: 429, response: { status: 429 } })).toBe(true);
    expect(
      isRateLimitError({
        code: 429,
        response: { status: 429, data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } },
      }),
    ).toBe(true);
  });

  it('treats a 403 as a back-off signal only with a rate-limit reason', () => {
    expect(isRateLimitError({ code: 403, errors: [{ reason: 'rateLimitExceeded' }] })).toBe(true);
    expect(
      isRateLimitError({
        code: 403,
        response: {
          status: 403,
          data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } },
        },
      }),
    ).toBe(true);
    expect(isRateLimitError({ code: 403, errors: [{ reason: 'forbidden' }] })).toBe(false);
    expect(isRateLimitError({ code: 403 })).toBe(false);
  });

  it('reads the reason off a stream response, where googleapis sets neither code nor errors', () => {
    // The shape a rate-limited media download (responseType: 'stream') throws.
    const body = JSON.stringify({
      error: { code: 403, errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }] },
    });
    expect(isRateLimitError({ status: 403, response: { status: 403, data: body } })).toBe(true);
    const denied = JSON.stringify({ error: { code: 403, errors: [{ reason: 'forbidden' }] } });
    expect(isRateLimitError({ status: 403, response: { status: 403, data: denied } })).toBe(false);
    expect(isRateLimitError({ status: 403, response: { status: 403, data: 'not json' } })).toBe(
      false,
    );
  });

  it('ignores everything else', () => {
    expect(isRateLimitError({ code: 404 })).toBe(false);
    expect(isRateLimitError({ code: 'ECONNRESET' })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});
