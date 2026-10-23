/**
 * capture.ts — opt-in record of rendered preset calls, for the thinking A/B
 * (scripts/ab-thinking.ts, #69).
 *
 * Off unless GEMINI_CAPTURE_DIR is set, which only a local run should do:
 * each record holds a rendered prompt, and so customer content. Records are
 * appended to `<dir>/<preset key>.jsonl`, readable by the owner only. A
 * directory inside this repository is refused, so captured content can
 * never be committed. A failed write never fails the call.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Schema } from '@google/genai';
import { logger } from '../logger';
import type { LlmUsage } from './ai.types';

export interface CapturedCall {
  capturedAt: string;
  key: string;
  model: string;
  temperature: number;
  prompt: string;
  responseSchema: Schema | null;
  timeoutMs: number | null;
  thinkingLevel: string | null;
  result: { text: string; finishReason: string | null; usage: LlmUsage | null };
}

/** True when `child` is `parent` or lies below it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The nearest directory above this module that holds a package.json. */
export function packageRoot(from: string = __dirname): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return from;
    dir = up;
  }
}

let refusedDir: string | null = null;

export function captureCall(dir: string, call: CapturedCall): void {
  try {
    if (isInside(dir, packageRoot()) || isInside(dir, process.cwd())) {
      if (refusedDir !== dir) {
        refusedDir = dir;
        logger.warn(
          { dir },
          '[llm] GEMINI_CAPTURE_DIR is inside the repository; nothing is captured',
        );
      }
      return;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${call.key.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(call) + '\n', { mode: 0o600 });
  } catch (err) {
    logger.warn(
      { key: call.key, error: err instanceof Error ? err.message : String(err) },
      '[llm] capture write failed',
    );
  }
}
