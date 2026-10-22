/**
 * Unit tests for idea-runner.ts's pure helpers. The module's imports are
 * mocked so loading it touches no Drive, database or model client.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../prisma', () => ({ prisma: {} }));
vi.mock('../../ai/gemini.client', () => ({ defaultLlm: { complete: vi.fn() } }));
vi.mock('../traversal', () => ({ traverseFolder: vi.fn() }));
vi.mock('../structure', () => ({ gatherFolders: vi.fn() }));
vi.mock('../extract', () => ({ extractText: vi.fn() }));

import { facetsEqual, renderFacets } from '../idea-runner';

describe('facetsEqual', () => {
  it('ignores order, case and surrounding space', () => {
    expect(
      facetsEqual(['late-night radio', 'Owl mascot'], [' owl MASCOT ', 'late-night radio']),
    ).toBe(true);
  });

  it('treats a row collapsed into a duplicate as a change', () => {
    expect(facetsEqual(['a', 'b'], ['a', 'a'])).toBe(false);
    expect(facetsEqual(['a', 'a'], ['a', 'b'])).toBe(false);
  });

  it('counts repeats: the same rows with different multiplicity differ', () => {
    expect(facetsEqual(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(false);
    expect(facetsEqual(['a', 'a', 'b'], ['b', 'a', 'A'])).toBe(true);
  });

  it('differs on length and on any changed row', () => {
    expect(facetsEqual(['a'], ['a', 'a'])).toBe(false);
    expect(facetsEqual(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(facetsEqual([], [])).toBe(true);
  });
});

describe('renderFacets', () => {
  it('renders one "- row" line per facet, the form idea_changes stores', () => {
    expect(renderFacets(['tongue in cheek', 'social-first'])).toBe(
      '- tongue in cheek\n- social-first',
    );
    expect(renderFacets([])).toBe('');
  });
});
