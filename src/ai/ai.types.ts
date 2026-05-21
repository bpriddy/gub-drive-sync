/**
 * ai.types.ts — Shared AI module types.
 */

import type { ResponseSchema } from '@google/generative-ai';

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
  responseSchema?: ResponseSchema;
}

export interface LlmCompletionResult {
  text: string;
  /** Driver name: 'gemini' or 'mock'. */
  driver: string;
  model: string;
  /** Raw response for debugging. Not persisted. */
  raw?: unknown;
}

export interface LlmDriver {
  readonly name: string;
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult>;
}
