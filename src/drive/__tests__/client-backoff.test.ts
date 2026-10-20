/**
 * Drive limiter back-off: what counts as a rate limit, and the jittered
 * schedule. googleapis is stubbed; the limiter is the real one.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ filesGet: vi.fn() }));

vi.mock('googleapis', () => ({ google: { drive: vi.fn(() => ({ files: { get: m.filesGet } })) } }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn(async () => ({})) }));
vi.mock('../../config', () => ({
  config: { DRIVE_READ_TIMEOUT_MS: 60_000, DRIVE_MEDIA_TIMEOUT_MS: 300_000 },
}));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DriveRateLimiter, downloadFileBuffer } from '../client';
import { isDrivePermissionError } from '../../scan/routing';

/** The shape a rate-limited `responseType: 'stream'` call throws: no code, no errors, raw body. */
const streamRateLimit = () => ({
  status: 403,
  response: {
    status: 403,
    data: JSON.stringify({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } }),
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  m.filesGet.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DriveRateLimiter back-off', () => {
  it('backs off on a 429 that carries no reason', async () => {
    const limiter = new DriveRateLimiter(1000);
    const fn = vi.fn().mockRejectedValueOnce({ code: 429 }).mockResolvedValue('ok');
    const p = limiter.run(fn);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('jitters the delay (×[0.5, 1.5) on the nominal 2 s first step)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const limiter = new DriveRateLimiter(1000);
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }] })
      .mockResolvedValue('ok');
    const p = limiter.run(fn);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('ok');
  });

  it('does not retry a permission 403', async () => {
    const limiter = new DriveRateLimiter(1000);
    const fn = vi.fn().mockRejectedValue({ code: 403, errors: [{ reason: 'forbidden' }] });
    await expect(limiter.run(fn)).rejects.toMatchObject({ code: 403 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('rate-limited media download', () => {
  it('is retried, not mistaken for a restricted file', async () => {
    expect(isDrivePermissionError(streamRateLimit())).toBe(false);
    m.filesGet
      .mockRejectedValueOnce(streamRateLimit())
      .mockResolvedValue({ data: Readable.from([Buffer.from('bytes')]) });
    const p = downloadFileBuffer('file-1');
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual(Buffer.from('bytes'));
    expect(m.filesGet).toHaveBeenCalledTimes(2);
  });
});
