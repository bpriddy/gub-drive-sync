/**
 * ai.types.ts — Shared AI module types.
 */

import type { Schema } from '@google/genai';

export interface LlmCompletionRequest {
  model: string;
  temperature: number;
  prompt: string;
  /** Tag recorded in logs for provenance (e.g. preset key that built the prompt). */
  tag?: string;
  /**
   * Gemini structured-output schema. When set, the driver requests
   * `application/json` responses conforming to this schema. The mock driver
   * reads the schema to fabricate minimally-valid responses so the rest of
   * the pipeline keeps running when no API key is set.
   */
  responseSchema?: Schema;
  /**
   * Cap on generated tokens. Omit to inherit the model default. Set high
   * for calls whose JSON response scales with input size (e.g. clustering a
   * large campaign roster) — a truncated response is invalid JSON and fails
   * the caller's parse.
   */
  maxOutputTokens?: number;
  /**
   * Cap on Gemini reasoning ("thinking") tokens (the 2.5-series knob;
   * 0 = disabled, -1 = automatic). Omit to let the model decide. A latency
   * lever — tune empirically; too low degrades quality.
   */
  thinkingBudget?: number;
  /**
   * Thinking level (the 3-series knob per the SDK's recommended practice):
   * 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'. Mutually exclusive with
   * thinkingBudget — set at most one.
   */
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface LlmUsage {
  promptTokens: number | null;
  thoughtsTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface LlmCompletionResult {
  text: string;
  /** Driver name: 'gemini' or 'mock'. */
  driver: string;
  model: string;
  /** Raw response for debugging. Not persisted. */
  raw?: unknown;
  /** Token accounting from the provider (prompt / thoughts / output). */
  usage?: LlmUsage;
}

export interface LlmDriver {
  readonly name: string;
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult>;
}
