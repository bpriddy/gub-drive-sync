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
  },
}));
vi.mock('../../logger', () => ({ logger: loggerMock }));

import { GeminiLlmDriver } from '../gemini.client';
import { isRetryableLlmError } from '../retryable';

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
    // The SDK's own retry wrapper (httpOptions.retryOptions) throws this
    // plain Error for 408/429/5xx; statusText may be empty on HTTP/2.
    expect(isRetryableLlmError(new Error('Retryable HTTP Error: Service Unavailable'))).toBe(true);
    expect(isRetryableLlmError(new Error('Retryable HTTP Error: '))).toBe(true);
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
