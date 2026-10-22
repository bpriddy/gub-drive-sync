/** Opt-in prompt capture for the thinking A/B: outside the repo only, never fatal. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

import { captureCall, isInside, packageRoot, type CapturedCall } from '../capture';

const call = (key = 'drive.file_extraction.v1'): CapturedCall => ({
  capturedAt: '2026-10-22T12:00:00.000Z',
  key,
  model: 'gemini-test',
  temperature: 0.2,
  prompt: 'rendered prompt',
  responseSchema: null,
  timeoutMs: 120000,
  thinkingLevel: null,
  result: { text: '{}', finishReason: 'STOP', usage: null },
});

let dir: string;
beforeEach(() => {
  warn.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-capture-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('captureCall', () => {
  it('appends one JSON line per call to <dir>/<key>.jsonl, owner-readable only', () => {
    const out = path.join(dir, 'capture');
    captureCall(out, call());
    captureCall(out, call());
    const file = path.join(out, 'drive.file_extraction.v1.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l))).toEqual([call(), call()]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a directory inside the repository and writes nothing', () => {
    const inside = path.join(packageRoot(), 'tmp-capture-should-not-exist');
    try {
      captureCall(inside, call());
      expect(fs.existsSync(inside)).toBe(false);
    } finally {
      // Keep the checkout clean even if the refusal is broken.
      fs.rmSync(inside, { recursive: true, force: true });
    }
    expect(warn).toHaveBeenCalledWith(
      { dir: inside },
      '[llm] GEMINI_CAPTURE_DIR is inside the repository; nothing is captured',
    );
  });

  it('never throws when the write fails', () => {
    const blocked = path.join(dir, 'a-file');
    fs.writeFileSync(blocked, '');
    expect(() => captureCall(path.join(blocked, 'sub'), call())).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'drive.file_extraction.v1' }),
      '[llm] capture write failed',
    );
  });

  it('tells inside from outside', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/x', '/a/b')).toBe(false);
  });
});
