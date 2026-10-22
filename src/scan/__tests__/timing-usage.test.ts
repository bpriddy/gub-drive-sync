/**
 * The run summary prints Gemini tokens per call tag (thoughts included)
 * ahead of the phase timing, and a new run starts from zero.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }));

vi.mock('../output', () => ({
  log: (line: string) => logs.push(line),
  rule: (title: string) => `── ${title} ──`,
  fmtMs: (ms: number) => `${ms}ms`,
}));

import { printPhaseSummary, resetPhaseTimer, timed } from '../timing';
import { recordLlmUsage } from '../../ai/usage-tally';

const usage = (prompt: number, output: number, thoughts: number) => ({
  promptTokens: prompt,
  outputTokens: output,
  thoughtsTokens: thoughts,
  totalTokens: prompt + output + thoughts,
  cachedContentTokens: 0,
});

beforeEach(() => {
  logs.length = 0;
});

describe('run summary: LLM tokens by call tag', () => {
  it('prints one row per tag and a total, before the phase timing', async () => {
    resetPhaseTimer();
    await timed('distill', async () => undefined);
    recordLlmUsage('drive.file_extraction.v1', usage(12000, 600, 4000), 'STOP');
    recordLlmUsage('drive.file_extraction.v1', usage(10000, 500, 3500), 'STOP');
    recordLlmUsage('drive.distillation.v1', usage(20000, 900, 9000), 'MAX_TOKENS');

    printPhaseSummary(1000);

    const header = logs.indexOf('── LLM tokens by call tag (this scan) ──');
    expect(header).toBeGreaterThanOrEqual(0);
    expect(logs.indexOf('── Phase timing (this scan) ──')).toBeGreaterThan(header);
    const rows = logs.slice(header + 1, header + 5).map((l) => l.trim().split(/\s{2,}/));
    expect(rows).toEqual([
      ['tag', 'calls', 'prompt', 'cached', 'output', 'thoughts'],
      ['drive.distillation.v1 (1 MAX_TOKENS)', '1', '20,000', '0', '900', '9,000'],
      ['drive.file_extraction.v1', '2', '22,000', '0', '1,100', '7,500'],
      ['total', '3', '42,000', '0', '2,000', '16,500'],
    ]);
  });

  it('starts every run from zero', () => {
    resetPhaseTimer();
    recordLlmUsage('drive.file_extraction.v1', usage(1, 1, 1), 'STOP');
    resetPhaseTimer();
    printPhaseSummary(0);
    expect(logs).not.toContain('── LLM tokens by call tag (this scan) ──');
  });
});
