/**
 * The global fetch dispatcher swap, against a real local HTTP server: the
 * point is that Node's bundled fetch honours an Agent from the undici
 * package — that is what makes a > 300 s Gemini deadline possible at all.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import {
  raiseFetchTimeouts,
  requiredFetchTimeoutMs,
  UNDICI_DEFAULT_TIMEOUT_MS,
} from '../fetch-timeouts';

describe('requiredFetchTimeoutMs', () => {
  it('leaves the dispatcher alone while the default covers every deadline', () => {
    expect(requiredFetchTimeoutMs([120_000, 240_000])).toBeNull();
    expect(requiredFetchTimeoutMs([0, 0])).toBeNull();
    expect(requiredFetchTimeoutMs([])).toBeNull();
  });

  it('raises it to the longest deadline plus a margin otherwise', () => {
    // The shipped defaults: interpret 120 s, distill 240 s, classify 420 s, default 300 s.
    expect(requiredFetchTimeoutMs([120_000, 240_000, 420_000, 300_000])).toBe(450_000);
    expect(requiredFetchTimeoutMs([300_000])).toBe(330_000);
    expect(UNDICI_DEFAULT_TIMEOUT_MS).toBe(300_000);
  });
});

describe('raiseFetchTimeouts', () => {
  let server: Server;
  let url: string;
  const original = getGlobalDispatcher();

  beforeAll(async () => {
    // Headers arrive only after the delay in the path — like a unary
    // generateContent that answers when the model is done.
    server = createServer((req, res) => {
      setTimeout(() => res.end('late'), Number(req.url?.slice(1)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    setGlobalDispatcher(original);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is what global fetch uses: a headers timeout below the delay fails the request', async () => {
    // undici's timers tick at ~0.5–1 s, so the delay sits well past that.
    raiseFetchTimeouts(100);
    const err = await fetch(`${url}2000`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError); // "fetch failed"
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT');
  });

  it('and one above it lets the slow answer through', async () => {
    raiseFetchTimeouts(5_000);
    const res = await fetch(`${url}300`);
    expect(await res.text()).toBe('late');
  });
});
