/**
 * gemini.client.ts — Gemini-backed LlmDriver with mock fallback.
 *
 * Driver selection:
 *   - GEMINI_API_KEY set → real Gemini via @google/generative-ai
 *   - unset             → MockLlmDriver returns a schema-shaped empty response
 *                         so the pipeline still runs end-to-end in dev.
 *
 * When a `responseSchema` is provided, we set responseMimeType=application/json
 * and Gemini guarantees the response conforms. The caller still runs its Zod
 * validation on top for type-narrowing + defense in depth.
 */

import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
  type Schema,
} from '@google/generative-ai';
import { config } from '../config';
import { logger } from '../logger';
import type { LlmCompletionRequest, LlmCompletionResult, LlmDriver } from './ai.types';

class GeminiLlmDriver implements LlmDriver {
  readonly name = 'gemini';
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const generationConfig: Record<string, unknown> = { temperature: req.temperature };
    if (req.responseSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = req.responseSchema;
    }
    const model = this.client.getGenerativeModel({
      model: req.model,
      generationConfig: generationConfig as never,
    });
    try {
      const res = await model.generateContent(req.prompt);
      const text = res.response.text();
      return { text, driver: this.name, model: req.model, raw: res };
    } catch (err) {
      logger.error({ err, model: req.model, tag: req.tag }, '[gemini] generateContent failed');
      throw err;
    }
  }
}

class MockLlmDriver implements LlmDriver {
  readonly name = 'mock';

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    logger.info({ tag: req.tag, model: req.model }, '[llm:mock] returning stub response');
    const text = req.responseSchema
      ? JSON.stringify(emptyInstance(req.responseSchema))
      : '[]';
    return { text, driver: this.name, model: req.model };
  }
}

/**
 * Build a minimally-valid instance of a responseSchema so mock responses
 * parse cleanly against caller Zod validators.
 */
function emptyInstance(schema: Schema | ResponseSchema): unknown {
  switch (schema.type) {
    case SchemaType.ARRAY:
      return [];
    case SchemaType.OBJECT: {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of schema.required ?? []) {
        const child = props[key];
        if (child) out[key] = emptyInstance(child);
      }
      return out;
    }
    case SchemaType.STRING:
      return '';
    case SchemaType.NUMBER:
    case SchemaType.INTEGER:
      return 0;
    case SchemaType.BOOLEAN:
      return false;
    default:
      return null;
  }
}

function createDriver(): LlmDriver {
  if (!config.GEMINI_API_KEY) {
    logger.warn('[llm] GEMINI_API_KEY unset — using mock driver. LLM interpretation will return empty results.');
    return new MockLlmDriver();
  }
  return new GeminiLlmDriver(config.GEMINI_API_KEY);
}

export const defaultLlm: LlmDriver = createDriver();
