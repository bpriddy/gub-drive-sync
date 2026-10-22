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
import { llmUsageByTag, resetLlmUsage } from '../usage-tally';
import { config } from '../../config';

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

describe('GeminiLlmDriver usage line', () => {
  function usageResponse(finishReason = 'STOP'): Response {
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason }],
        usageMetadata: {
          promptTokenCount: 1200,
          candidatesTokenCount: 300,
          thoughtsTokenCount: 4100,
          cachedContentTokenCount: 800,
          totalTokenCount: 5600,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  it('logs tokens per call at INFO, with the old keys and the provider field names', async () => {
    fetchMock.mockResolvedValue(usageResponse());
    const res = await driver().complete(REQ);
    expect(loggerMock.info).toHaveBeenCalledWith(
      {
        model: 'gemini-test',
        tag: 'unit.test',
        promptTokens: 1200,
        thoughtsTokens: 4100,
        outputTokens: 300,
        totalTokens: 5600,
        cachedContentTokens: 800,
        promptTokenCount: 1200,
        candidatesTokenCount: 300,
        thoughtsTokenCount: 4100,
        cachedContentTokenCount: 800,
        finishReason: 'STOP',
      },
      '[gemini] usage',
    );
    expect(loggerMock.debug).not.toHaveBeenCalledWith(expect.anything(), '[gemini] usage');
    expect(res.finishReason).toBe('STOP');
    expect(res.usage).toMatchObject({ thoughtsTokens: 4100, cachedContentTokens: 800 });
  });

  it('adds every attempt to the per-tag totals', async () => {
    resetLlmUsage();
    fetchMock.mockImplementation(async () => usageResponse());
    await driver().complete(REQ);
    await driver().complete({ ...REQ, tag: 'other.tag' });
    await driver().complete(REQ);
    expect(llmUsageByTag()).toEqual([
      {
        tag: 'unit.test',
        calls: 2,
        promptTokens: 2400,
        cachedContentTokens: 1600,
        outputTokens: 600,
        thoughtsTokens: 8200,
        maxTokensFinishes: 0,
      },
      {
        tag: 'other.tag',
        calls: 1,
        promptTokens: 1200,
        cachedContentTokens: 800,
        outputTokens: 300,
        thoughtsTokens: 4100,
        maxTokensFinishes: 0,
      },
    ]);
  });
});

describe('GeminiLlmDriver thinking level from GEMINI_THINKING_BY_TAG', () => {
  const sentConfig = (): Record<string, unknown> => {
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      generationConfig?: Record<string, unknown>;
    };
    return body.generationConfig ?? {};
  };

  beforeEach(() => {
    fetchMock.mockImplementation(async () => okResponse());
  });

  afterEach(() => {
    (config as { GEMINI_THINKING_BY_TAG?: unknown }).GEMINI_THINKING_BY_TAG = undefined;
  });

  it('sends no thinking parameter when the map is empty or absent', async () => {
    (config as { GEMINI_THINKING_BY_TAG?: unknown }).GEMINI_THINKING_BY_TAG = {};
    await driver().complete(REQ);
    expect(sentConfig()).not.toHaveProperty('thinkingConfig');
  });

  it('sends the mapped level for a tag, by exact tag or call-type name', async () => {
    (config as { GEMINI_THINKING_BY_TAG?: unknown }).GEMINI_THINKING_BY_TAG = {
      'unit.test': 'LOW',
      distill: 'MINIMAL',
    };
    await driver().complete(REQ);
    expect(sentConfig()).toMatchObject({ thinkingConfig: { thinkingLevel: 'LOW' } });
    fetchMock.mockClear();
    await driver().complete({ ...REQ, tag: 'drive.distillation.v1' });
    expect(sentConfig()).toMatchObject({ thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'drive.distillation.v1', thinkingLevel: 'MINIMAL' }),
      '[gemini] generateContent finished',
    );
  });

  it("never adds a level to a caller's own thinking budget (the two together are a 400)", async () => {
    (config as { GEMINI_THINKING_BY_TAG?: unknown }).GEMINI_THINKING_BY_TAG = {
      'unit.test': 'LOW',
    };
    await driver().complete({ ...REQ, thinkingBudget: 0 });
    expect(sentConfig()).toMatchObject({ thinkingConfig: { thinkingBudget: 0 } });
    expect(sentConfig()['thinkingConfig']).not.toHaveProperty('thinkingLevel');
  });
});
