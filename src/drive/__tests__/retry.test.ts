import { describe, expect, it, vi } from 'vitest';
import { isTransientTransportError, withTransientRetry } from '../retry';

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
  it('returns the first success without waiting', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withTransientRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries through a transient fault and succeeds', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ code: 503 })
        .mockResolvedValue('ok');
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
});
