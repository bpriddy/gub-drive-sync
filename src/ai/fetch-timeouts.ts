/**
 * fetch-timeouts.ts — make room in Node's fetch for the Gemini deadlines.
 *
 * @google/genai calls the global `fetch`, whose undici dispatcher cuts any
 * request at 300 s by default (headersTimeout and bodyTimeout; a unary
 * generateContent sends its headers only when the answer is ready). The
 * SDK tries to lift those limits when `httpOptions.timeout` is set, but on
 * Node 22 it looks for them on the global Agent, which does not carry them
 * (they live on its per-origin clients), so the lift never happens. Without
 * this module a call that legitimately needs longer than 300 s — folder
 * classify on a large drive — dies at 300 s as "fetch failed", whatever its
 * configured deadline.
 *
 * Each Gemini attempt carries its own deadline (httpOptions.timeout), so
 * the dispatcher only has to stay out of the way: it is raised to the
 * longest configured deadline plus a margin, and left alone when undici's
 * default already covers every deadline.
 */
import { Agent, setGlobalDispatcher } from 'undici';

/** undici's default headersTimeout / bodyTimeout for Node's global fetch. */
export const UNDICI_DEFAULT_TIMEOUT_MS = 300_000;
/** Headroom so the per-request deadline, not the dispatcher, fires first. */
const DISPATCHER_MARGIN_MS = 30_000;

/**
 * The headers/body timeout the global fetch dispatcher needs so no Gemini
 * call is cut before its own deadline, or null when the default suffices.
 */
export function requiredFetchTimeoutMs(deadlinesMs: readonly number[]): number | null {
  const longest = Math.max(0, ...deadlinesMs);
  if (longest === 0) return null;
  const needed = longest + DISPATCHER_MARGIN_MS;
  return needed > UNDICI_DEFAULT_TIMEOUT_MS ? needed : null;
}

/** Replace the global fetch dispatcher with one that allows `timeoutMs`. */
export function raiseFetchTimeouts(timeoutMs: number): void {
  setGlobalDispatcher(new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }));
}
