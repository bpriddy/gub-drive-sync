/**
 * queryActivityWindow retries its POST: the Activity query is an
 * idempotent read that gaxios never retries itself. The googleapis client
 * is stubbed; the limiter and the retry wrapper are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('googleapis', () => ({
  google: { driveactivity: vi.fn(() => ({ activity: { query: m.query } })) },
}));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn(async () => ({})) }));
vi.mock('../../config', () => ({ config: { DRIVE_READ_TIMEOUT_MS: 60_000 } }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { queryActivityWindow } from '../activity';

const PAGE = {
  data: {
    activities: [
      {
        timestamp: '2026-10-19T09:00:00Z',
        actions: [{ detail: { edit: {} } }],
        targets: [{ driveItem: { name: 'items/f1', title: 'Doc' } }],
        actors: [{ user: { knownUser: { personName: 'people/1' } } }],
      },
    ],
  },
};

const query = () => queryActivityWindow('root-1', '2026-10-18T00:00:00Z', '2026-10-20T00:00:00Z');

/** Run the query while fake time passes, so backoff sleeps don't wait for real. */
async function drain<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  const r = await settled;
  if (!r.ok) throw r.e;
  return r.v;
}

beforeEach(() => {
  vi.useFakeTimers();
  m.query.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('queryActivityWindow retries the POST', () => {
  it('retries a 503 and returns the page', async () => {
    m.query.mockRejectedValueOnce({ code: 503, message: 'backend error' }).mockResolvedValue(PAGE);
    const events = await drain(query());
    expect(events).toEqual([expect.objectContaining({ fileId: 'f1', action: 'edit' })]);
    expect(m.query).toHaveBeenCalledTimes(2);
  });

  it('retries a rate limit through the limiter', async () => {
    m.query
      .mockRejectedValueOnce({ code: 429, errors: [{ reason: 'rateLimitExceeded' }] })
      .mockResolvedValue(PAGE);
    await expect(drain(query())).resolves.toHaveLength(1);
    expect(m.query).toHaveBeenCalledTimes(2);
  });

  it('retries a request that timed out', async () => {
    m.query
      .mockRejectedValueOnce({
        message: 'network timeout at: …',
        error: { type: 'request-timeout' },
      })
      .mockResolvedValue(PAGE);
    await expect(drain(query())).resolves.toHaveLength(1);
    expect(m.query).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent error', async () => {
    m.query.mockRejectedValue({ code: 400, message: 'invalid filter' });
    await expect(drain(query())).rejects.toEqual({ code: 400, message: 'invalid filter' });
    expect(m.query).toHaveBeenCalledTimes(1);
  });
});
