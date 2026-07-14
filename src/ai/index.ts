export { runPreset, parseLlmJson } from './prompt-preset.service';
export { defaultLlm } from './gemini.client';
export type { LlmDriver, LlmCompletionRequest, LlmCompletionResult, LlmUsage } from './ai.types';
// The SDK's schema surface, re-exported so consumers never import the vendor
// package directly (one place to swap on the next SDK migration). SchemaType
// is the old SDK's name for the enum — kept as an alias to minimize churn.
export { Type as SchemaType } from '@google/genai';
export type { Schema, Schema as ResponseSchema } from '@google/genai';
