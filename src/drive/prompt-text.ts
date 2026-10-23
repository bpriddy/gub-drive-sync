/**
 * prompt-text.ts — the slice of a file's text the interpret prompt shows.
 *
 * One definition for interpret.ts, which builds the prompt from it, and for
 * the unchanged-content gate (src/scan/content-gate.ts), which hashes it: the
 * gate may only skip what the model would not have seen differently.
 */
import { config } from '../config';

export interface PromptFileText {
  /** The text the prompt shows, before the truncation note. */
  visible: string;
  /** True when the text was cut at GEMINI_MAX_INPUT_CHARS. */
  truncated: boolean;
  /** Characters cut off the end (0 when not truncated). */
  omitted: number;
}

export function promptFileText(text: string): PromptFileText {
  const max = config.GEMINI_MAX_INPUT_CHARS;
  return text.length > max
    ? { visible: text.slice(0, max), truncated: true, omitted: text.length - max }
    : { visible: text, truncated: false, omitted: 0 };
}
