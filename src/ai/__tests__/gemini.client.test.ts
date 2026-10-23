/**
 * GeminiLlmDriver against a stubbed `fetch` — the real @google/genai SDK
 * runs end to end (URL building, error shaping, response parsing); only the
 * transport is replaced. Retry behaviour depends on exactly how the SDK
 * surfaces an HTTP failure, so mocking the SDK itself would hide the thing
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config', () => ({
  config: {
    GEMINI_USE_ENTERPRISE: false,
    GEMINI_API_KEY: undefined,
    GCP_PROJECT_ID: undefined,
    GEMINI_LOCATION: 'global',
    // Real defaults are minutes; the stall tests need the default path to
    // fire within a test's lifetime.
    GEMINI_TIMEOUT_DEFAULT_MS: 40,
  },
}));
vi.mock('../../logger', () => ({ logger: loggerMock }));

import { GeminiLlmDriver } from '../gemini.client';
import { isRetryableLlmError, LlmTimeoutError } from '../retryable';

function okResponse(text = '{"ok":true}', finishReason = 'STOP'): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errorResponse(status: number, statusText: string): Response {
  return new Response(
    JSON.stringify({ error: { code: status, message: `stubbed ${status}`, status: statusText } }),
    { status, statusText, headers: { 'content-type': 'application/json' } },
  );
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const sleeps: number[] = [];
const sleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};

function driver(): GeminiLlmDriver {
  return new GeminiLlmDriver({ apiKey: 'test-key' }, { sleep });
}

const REQ = { model: 'gemini-test', temperature: 0, prompt: 'hi', tag: 'unit.test' };

beforeEach(() => {
  fetchMock.mockReset();
  sleeps.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  for (const fn of Object.values(loggerMock)) fn.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GeminiLlmDriver retries', () => {
  it('retries a 503 and returns the next success', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(503, 'Service Unavailable'))
      .mockResolvedValueOnce(okResponse('{"a":1}'));
    const res = await driver().complete(REQ);
    expect(res.text).toBe('{"a":1}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 and returns the next success', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, 'Too Many Requests'))
      .mockResolvedValueOnce(okResponse());
    await expect(driver().complete(REQ)).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 408', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(408, 'Request Timeout'))
      .mockResolvedValueOnce(okResponse());
    await expect(driver().complete(REQ)).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400, and surfaces the typed ApiError with its status', async () => {
    fetchMock.mockResolvedValue(errorResponse(400, 'Bad Request'));
    const err = await driver()
      .complete(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('gives up after 3 attempts with jittered exponential backoff between them', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    fetchMock.mockImplementation(async () => errorResponse(503, 'Service Unavailable'));
    const err = await driver()
      .complete(REQ)
      .catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Nominal 1 s → 3 s, each scaled by (0.5 + random) — 0.99 sits at the top.
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBe(Math.round(1000 * 1.49));
    expect(sleeps[1]).toBe(Math.round(3000 * 1.49));
  });

  it('keeps the DEBUG failure line and adds a WARN line per failed attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(503, 'Service Unavailable'))
      .mockResolvedValueOnce(okResponse());
    await driver().complete(REQ);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'unit.test', attempt: 1, retryable: true, willRetry: true }),
      '[gemini] generateContent failed',
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: 'unit.test',
        attempt: 1,
        maxAttempts: 3,
        status: 503,
        retryable: true,
        willRetry: true,
      }),
      '[gemini] generateContent attempt failed',
    );
  });
});

describe('isRetryableLlmError', () => {
  it('matches every way a transient failure reaches us', () => {
    expect(isRetryableLlmError(new ApiError({ message: 'x', status: 429 }))).toBe(true);
    expect(isRetryableLlmError(new ApiError({ message: 'x', status: 408 }))).toBe(true);
    expect(isRetryableLlmError(new ApiError({ message: 'x', status: 500 }))).toBe(true);
    expect(isRetryableLlmError(new ApiError({ message: 'x', status: 504 }))).toBe(true);
    expect(isRetryableLlmError(new TypeError('fetch failed'))).toBe(true);
  });

  it('rejects permanent failures', () => {
    expect(isRetryableLlmError(new ApiError({ message: 'x', status: 400 }))).toBe(false);
    expect(isRetryableLlmError(new ApiError({ message: 'x', status: 403 }))).toBe(false);
    expect(
      isRetryableLlmError(new Error('Non-retryable exception Bad Request sending request')),
    ).toBe(false);
    expect(isRetryableLlmError(new SyntaxError('Unexpected end of JSON input'))).toBe(false);
    expect(isRetryableLlmError(null)).toBe(false);
  });
});

/** A fetch that never answers until its signal aborts — then rejects like real fetch. */
function stalledFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // no deadline: hang (the test would time out)
    signal.addEventListener('abort', () =>
      reject(new DOMException('This operation was aborted', 'AbortError')),
    );
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('GeminiLlmDriver per-attempt deadline', () => {
  it('aborts a stalled attempt at its timeout, then retries and succeeds', async () => {
    fetchMock.mockImplementationOnce(stalledFetch).mockResolvedValueOnce(okResponse('{"b":2}'));
    const res = await driver().complete({ ...REQ, timeoutMs: 30 });
    expect(res.text).toBe('{"b":2}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The deadline also reaches the server (seconds, rounded up).
    expect(headerOf(fetchMock.mock.calls[0]![1], 'X-Server-Timeout')).toBe('1');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, retryable: true, willRetry: true }),
      '[gemini] generateContent attempt failed',
    );
  });

  it('surfaces a named timeout once every attempt stalls', async () => {
    fetchMock.mockImplementation(stalledFetch);
    const err = await driver()
      .complete({ ...REQ, timeoutMs: 20 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect((err as LlmTimeoutError).message).toBe('[gemini] request timed out after 20 ms');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back to GEMINI_TIMEOUT_DEFAULT_MS when the call type sets none', async () => {
    fetchMock.mockImplementation(stalledFetch);
    const err = await driver()
      .complete(REQ)
      .catch((e: unknown) => e);
    expect((err as LlmTimeoutError).timeoutMs).toBe(40);
  });

  it('sets no deadline at all when the timeout is 0 (the rollback)', async () => {
    fetchMock.mockResolvedValue(okResponse());
    await driver().complete({ ...REQ, timeoutMs: 0 });
    const init = fetchMock.mock.calls[0]![1];
    expect(init?.signal ?? null).toBeNull();
    expect(headerOf(init, 'X-Server-Timeout')).toBeNull();
  });
});

describe('GeminiLlmDriver finish logging', () => {
  it('logs finishReason for every completed call at INFO', async () => {
    fetchMock.mockResolvedValue(okResponse('{"truncat', 'MAX_TOKENS'));
    await driver().complete(REQ);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-test',
        tag: 'unit.test',
        attempt: 1,
        finishReason: 'MAX_TOKENS',
        blockReason: null,
        promptTokens: 10,
        outputTokens: 3,
        durationMs: expect.any(Number),
      }),
      '[gemini] generateContent finished',
    );
  });

  it('logs it on the attempt that finally succeeded', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(503, 'Service Unavailable'))
      .mockResolvedValueOnce(okResponse());
    await driver().complete(REQ);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2, finishReason: 'STOP' }),
      '[gemini] generateContent finished',
    );
  });
});
