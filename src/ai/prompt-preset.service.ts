/**
 * prompt-preset.service.ts — Editable-preset prompts.
 *
 * Loads a PromptPreset row by key, renders the template with caller-supplied
 * variables (double-brace placeholders like {{account_name}}), and hands off
 * to the LLM driver.
 *
 * Missing variables render as empty strings with a warning — the preset owns
 * the prompt contract, not the caller.
 */

import type { Schema } from '@google/genai';
import { config } from '../config';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { defaultLlm } from './gemini.client';
import { thinkingLevelFor, type ThinkingLevelName } from './thinking';
import { captureCall } from './capture';
import type { LlmCompletionResult } from './ai.types';

export interface RunPresetOptions {
  key: string;
  variables: Record<string, string | number | boolean | null | undefined>;
  /** Optional Gemini structured-output schema — forces JSON responses. */
  responseSchema?: Schema;
  /** Per-attempt deadline for this call type (see LlmCompletionRequest.timeoutMs). */
  timeoutMs?: number;
  /**
   * Thinking level for this call. Omitted: GEMINI_THINKING_BY_TAG decides by
   * preset key (or its call-type name); no entry means no thinking
   * parameter. Lives in code and env, not on the preset row: no schema
   * change.
   */
  thinkingLevel?: ThinkingLevelName;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function renderTemplate(template: string, variables: RunPresetOptions['variables']): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!(name in variables)) {
      logger.warn({ name }, '[prompt-preset] template references unknown variable');
      return '';
    }
    const value = variables[name];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}

export async function runPreset(
  opts: RunPresetOptions,
): Promise<LlmCompletionResult & { prompt: string }> {
  const preset = await prisma.promptPreset.findUnique({ where: { key: opts.key } });
  if (!preset) {
    throw new Error(`[prompt-preset] no preset found with key=${opts.key}`);
  }
  if (!preset.isActive) {
    throw new Error(`[prompt-preset] preset ${opts.key} is inactive`);
  }

  const prompt = renderTemplate(preset.template, opts.variables);
  const thinkingLevel =
    opts.thinkingLevel ?? thinkingLevelFor(opts.key, config.GEMINI_THINKING_BY_TAG ?? {});
  const result = await defaultLlm.complete({
    model: preset.model,
    temperature: Number(preset.temperature),
    prompt,
    tag: opts.key,
    ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });

  if (config.GEMINI_CAPTURE_DIR) {
    captureCall(config.GEMINI_CAPTURE_DIR, {
      capturedAt: new Date().toISOString(),
      key: opts.key,
      model: preset.model,
      temperature: Number(preset.temperature),
      prompt,
      responseSchema: opts.responseSchema ?? null,
      timeoutMs: opts.timeoutMs ?? null,
      thinkingLevel: thinkingLevel ?? null,
      result: {
        text: result.text,
        finishReason: result.finishReason ?? null,
        usage: result.usage ?? null,
      },
    });
  }

  return { ...result, prompt };
}

/**
 * Parse a JSON response from the LLM, tolerant of:
 *   - Leading/trailing markdown fences (```json ... ```)
 *   - Leading "Here is the JSON:" chatter
 */
export function parseLlmJson<T = unknown>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : raw;
  if (!candidate) throw new Error('[prompt-preset] empty LLM response');
  const firstBrace = candidate.search(/[[{]/);
  const sliced = firstBrace >= 0 ? candidate.slice(firstBrace) : candidate;
  return JSON.parse(sliced) as T;
}
