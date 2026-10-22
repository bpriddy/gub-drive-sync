/**
 * Unit tests for idea-matcher.ts — match + merge of a new idea against the
 * account's known ideas. The LLM is a vi.fn; no real Gemini client is built.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../prisma', () => ({ prisma: {} }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.loggerError },
}));
vi.mock('../../ai/gemini.client', () => ({ defaultLlm: { complete: mocks.complete } }));

import { DEFAULT_GEMINI_MODEL } from '../../ai';
import { matchAndMergeIdea, type KnownIdea } from '../idea-matcher';

const newIdea = { name: 'Night Owl Route', facets: ['tongue in cheek', 'social-first'] };

function known(n: number): KnownIdea[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `idea-${i + 1}`,
    name: `Example Idea ${i + 1}`,
    facets: [`facet of ${i + 1}`],
  }));
}

function respond(payload: unknown): void {
  mocks.complete.mockResolvedValueOnce({ text: JSON.stringify(payload) });
}

describe('matchAndMergeIdea', () => {
  beforeEach(() => {
    mocks.complete.mockReset();
    mocks.loggerError.mockReset();
  });

  it('with no existing ideas skips the LLM and returns the new idea facets untouched', async () => {
    const res = await matchAndMergeIdea({ newIdea, existingIdeas: [], accountName: 'Acme' });
    expect(res).toEqual({ matchId: null, mergedFacets: ['tongue in cheek', 'social-first'] });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('match_index 0 means "new idea": matchId null and the new facets', async () => {
    respond({ match_index: 0, merged_facets: ['something the model emitted anyway'] });
    const res = await matchAndMergeIdea({ newIdea, existingIdeas: known(3), accountName: 'Acme' });
    expect(res).toEqual({ matchId: null, mergedFacets: ['tongue in cheek', 'social-first'] });
  });

  it('treats an out-of-range index (candidates + 1) as no match', async () => {
    respond({ match_index: 4, merged_facets: ['x'] });
    const res = await matchAndMergeIdea({ newIdea, existingIdeas: known(3), accountName: 'Acme' });
    expect(res).toEqual({ matchId: null, mergedFacets: ['tongue in cheek', 'social-first'] });
  });

  it('accepts the last valid index (== candidates.length)', async () => {
    respond({ match_index: 3, merged_facets: ['kept'] });
    const res = await matchAndMergeIdea({ newIdea, existingIdeas: known(3), accountName: 'Acme' });
    expect(res).toEqual({ matchId: 'idea-3', mergedFacets: ['kept'] });
  });

  it('a valid index returns that candidate id with trimmed, non-empty merged facets', async () => {
    respond({
      match_index: 2,
      merged_facets: ['  unified row one ', '', '   ', 'unified row two\n'],
    });
    const res = await matchAndMergeIdea({ newIdea, existingIdeas: known(3), accountName: 'Acme' });
    expect(res).toEqual({
      matchId: 'idea-2',
      mergedFacets: ['unified row one', 'unified row two'],
    });
  });

  it('falls back to a case-insensitive de-duplicated union (old then new, in order) when merged_facets is empty', async () => {
    const existing: KnownIdea[] = [
      { id: 'idea-a', name: 'Example Idea A', facets: ['Tongue In Cheek', 'hand-made look'] },
    ];
    respond({ match_index: 1, merged_facets: [] });
    const res = await matchAndMergeIdea({
      newIdea: {
        name: 'Night Owl Route',
        facets: ['tongue in cheek', '  Social-First ', '', 'social-first'],
      },
      existingIdeas: existing,
      accountName: 'Acme',
    });
    expect(res.matchId).toBe('idea-a');
    expect(res.mergedFacets).toEqual(['Tongue In Cheek', 'hand-made look', 'Social-First']);
  });

  it('falls back to the union when merged_facets holds only blanks (never blanks the idea)', async () => {
    const existing: KnownIdea[] = [
      { id: 'idea-a', name: 'Example Idea A', facets: ['hand-made look'] },
    ];
    respond({ match_index: 1, merged_facets: ['', '  '] });
    const res = await matchAndMergeIdea({ newIdea, existingIdeas: existing, accountName: 'Acme' });
    expect(res.mergedFacets).toEqual(['hand-made look', 'tongue in cheek', 'social-first']);
  });

  it('caps candidates to the LAST 50 and resolves the index relative to the capped list', async () => {
    const existing = known(60);
    respond({ match_index: 1, merged_facets: ['kept'] });
    const res = await matchAndMergeIdea({ newIdea, existingIdeas: existing, accountName: 'Acme' });
    // capped list = ideas 11..60, so [1] is the 11th existing idea
    expect(res.matchId).toBe('idea-11');

    const prompt: string = mocks.complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('[1] Example Idea 11\n');
    expect(prompt).toContain('[50] Example Idea 60\n');
    expect(prompt).not.toContain('[51]');
    expect(prompt).not.toContain('Example Idea 10\n');
    expect(prompt).not.toContain('Example Idea 1\n');
  });

  it('index 50 on 60 existing ideas picks the newest one; 51 is out of range', async () => {
    respond({ match_index: 50, merged_facets: ['kept'] });
    const hit = await matchAndMergeIdea({ newIdea, existingIdeas: known(60), accountName: 'Acme' });
    expect(hit.matchId).toBe('idea-60');

    respond({ match_index: 51, merged_facets: ['kept'] });
    const miss = await matchAndMergeIdea({
      newIdea,
      existingIdeas: known(60),
      accountName: 'Acme',
    });
    expect(miss.matchId).toBeNull();
  });

  it('does not cap when there are 50 or fewer ideas', async () => {
    respond({ match_index: 1, merged_facets: ['kept'] });
    const res = await matchAndMergeIdea({ newIdea, existingIdeas: known(50), accountName: 'Acme' });
    expect(res.matchId).toBe('idea-1');
  });

  it('calls the LLM with the pinned model, temperature, tag, token cap and schema', async () => {
    respond({ match_index: 0, merged_facets: [] });
    await matchAndMergeIdea({ newIdea, existingIdeas: known(2), accountName: 'Acme' });
    const req = mocks.complete.mock.calls[0][0];
    expect(req.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(req.temperature).toBe(0.1);
    expect(req.tag).toBe('drive.idea_match_merge.v1');
    expect(req.maxOutputTokens).toBe(16384);
    expect(req.responseSchema).toMatchObject({ required: ['match_index', 'merged_facets'] });
  });

  it('renders account, new idea facets, and candidate facets (or a no-facets marker) in the prompt', async () => {
    respond({ match_index: 0, merged_facets: [] });
    await matchAndMergeIdea({
      newIdea,
      existingIdeas: [
        { id: 'idea-1', name: 'Example Idea 1', facets: ['hand-made look'] },
        { id: 'idea-2', name: 'Example Idea 2', facets: [] },
      ],
      accountName: null,
    });
    const prompt: string = mocks.complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('ACCOUNT: (unknown)');
    expect(prompt).toContain('  Night Owl Route\n    - tongue in cheek\n    - social-first');
    expect(prompt).toContain('[1] Example Idea 1\n      - hand-made look');
    expect(prompt).toContain('[2] Example Idea 2\n      (no facets yet)');
  });

  it('throws and logs (raw capped at 400 chars) on a non-JSON completion', async () => {
    const garbage = 'nope '.repeat(200);
    mocks.complete.mockResolvedValueOnce({ text: garbage });
    await expect(
      matchAndMergeIdea({ newIdea, existingIdeas: known(2), accountName: 'Acme' }),
    ).rejects.toThrow();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [ctx, msg] = mocks.loggerError.mock.calls[0];
    expect(msg).toBe('[drive.idea-matcher] parse failed');
    expect(ctx.raw).toBe(garbage.slice(0, 400));
  });

  it('throws on a schema-invalid completion (negative or fractional index)', async () => {
    respond({ match_index: -1, merged_facets: [] });
    await expect(
      matchAndMergeIdea({ newIdea, existingIdeas: known(2), accountName: 'Acme' }),
    ).rejects.toThrow();
    respond({ match_index: 1.5, merged_facets: [] });
    await expect(
      matchAndMergeIdea({ newIdea, existingIdeas: known(2), accountName: 'Acme' }),
    ).rejects.toThrow();
    expect(mocks.loggerError).toHaveBeenCalledTimes(2);
  });
});
