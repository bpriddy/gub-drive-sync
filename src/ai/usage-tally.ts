/**
 * usage-tally.ts — Gemini token totals per call tag for one run.
 *
 * The driver records every completed attempt, used or not, because every
 * attempt is billed. The run summary (scan/timing.ts) prints one line per
 * tag and resets the tally at the start of each run. Thoughts bill as
 * output, so `outputTokens + thoughtsTokens` is the output side of the cost.
 */
import type { LlmUsage } from './ai.types';

export interface TagUsageTotals {
  calls: number;
  promptTokens: number;
  cachedContentTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  /** Attempts that stopped at the output token limit. */
  maxTokensFinishes: number;
}

const totals = new Map<string, TagUsageTotals>();

export function recordLlmUsage(
  tag: string | undefined,
  usage: LlmUsage | undefined,
  finishReason: string | null,
): void {
  const key = tag ?? '(untagged)';
  let t = totals.get(key);
  if (!t) {
    t = {
      calls: 0,
      promptTokens: 0,
      cachedContentTokens: 0,
      outputTokens: 0,
      thoughtsTokens: 0,
      maxTokensFinishes: 0,
    };
    totals.set(key, t);
  }
  t.calls++;
  t.promptTokens += usage?.promptTokens ?? 0;
  t.cachedContentTokens += usage?.cachedContentTokens ?? 0;
  t.outputTokens += usage?.outputTokens ?? 0;
  t.thoughtsTokens += usage?.thoughtsTokens ?? 0;
  if (finishReason === 'MAX_TOKENS') t.maxTokensFinishes++;
}

export function resetLlmUsage(): void {
  totals.clear();
}

/** One row per tag, largest output side (output + thoughts) first. */
export function llmUsageByTag(): Array<{ tag: string } & TagUsageTotals> {
  return Array.from(totals, ([tag, t]) => ({ tag, ...t })).sort(
    (a, b) => b.outputTokens + b.thoughtsTokens - (a.outputTokens + a.thoughtsTokens),
  );
}
