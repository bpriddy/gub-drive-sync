/** runPreset threads the thinking level from GEMINI_THINKING_BY_TAG by preset key. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  complete: vi.fn(),
  config: { GEMINI_THINKING_BY_TAG: {} as Record<string, string> },
}));

vi.mock('../../config', () => ({ config: m.config }));
vi.mock('../../prisma', () => ({ prisma: { promptPreset: { findUnique: m.findUnique } } }));
vi.mock('../gemini.client', () => ({ defaultLlm: { complete: m.complete } }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runPreset } from '../prompt-preset.service';

const run = (extra: { thinkingLevel?: 'LOW' | 'HIGH' } = {}) =>
  runPreset({ key: 'drive.file_extraction.v1', variables: { name: 'x' }, ...extra });

beforeEach(() => {
  m.config.GEMINI_THINKING_BY_TAG = {};
  m.findUnique.mockResolvedValue({
    key: 'drive.file_extraction.v1',
    isActive: true,
    template: 'Hello {{name}}',
    model: 'gemini-test',
    temperature: '0.2',
  });
  m.complete.mockReset().mockResolvedValue({ text: '{}', driver: 'gemini', model: 'gemini-test' });
});

describe('runPreset thinking level', () => {
  it('sends no thinking level while the map is empty (today, and the rollback)', async () => {
    await run();
    expect(m.complete).toHaveBeenCalledTimes(1);
    expect(m.complete.mock.calls[0]![0]).not.toHaveProperty('thinkingLevel');
  });

  it("sends the mapped level for the preset's call type", async () => {
    m.config.GEMINI_THINKING_BY_TAG = { interpret: 'LOW' };
    await run();
    expect(m.complete).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'drive.file_extraction.v1', thinkingLevel: 'LOW' }),
    );
  });

  it("lets the caller's own level win over the map", async () => {
    m.config.GEMINI_THINKING_BY_TAG = { interpret: 'LOW' };
    await run({ thinkingLevel: 'HIGH' });
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'HIGH' }));
  });
});
