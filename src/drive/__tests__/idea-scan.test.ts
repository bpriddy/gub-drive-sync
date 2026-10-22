/**
 * Unit tests for idea-scan.ts — the ideas flow wired into the real scan.
 * Extraction and matching are mocked (covered by their own test files);
 * prisma is a fake. The real idea-runner helpers (facetsEqual/renderFacets)
 * and the real DRIVE_SYNC_SYSTEM_STAFF_ID are used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    idea: { create: vi.fn() },
    ideaChange: { create: vi.fn() },
  };
  return {
    extractIdeasFromFile: vi.fn(),
    matchAndMergeIdea: vi.fn(),
    findMany: vi.fn(),
    ideaUpdate: vi.fn(),
    ideaChangeCreate: vi.fn(),
    transaction: vi.fn(),
    tx,
    loggerWarn: vi.fn(),
  };
});

vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn() },
}));
vi.mock('../../prisma', () => ({
  prisma: {
    idea: { findMany: mocks.findMany, update: mocks.ideaUpdate },
    ideaChange: { create: mocks.ideaChangeCreate },
    $transaction: mocks.transaction,
  },
}));
// No real Gemini client, and no Google/traversal side effects via idea-runner / heal.
vi.mock('../../ai/gemini.client', () => ({ defaultLlm: { complete: vi.fn() } }));
vi.mock('../traversal', () => ({ traverseFolder: vi.fn() }));
vi.mock('../structure', () => ({ gatherFolders: vi.fn() }));
vi.mock('../extract', () => ({ extractText: vi.fn() }));
vi.mock('../idea-extraction', () => ({ extractIdeasFromFile: mocks.extractIdeasFromFile }));
vi.mock('../idea-matcher', () => ({ matchAndMergeIdea: mocks.matchAndMergeIdea }));

import { createIdeaScanContext, extractIdeaCandidates, mergeIdeaCandidates } from '../idea-scan';
import { DRIVE_SYNC_SYSTEM_STAFF_ID } from '../heal';
import type { TraversedFile } from '../types';

const file = (id: string): TraversedFile => ({
  id,
  name: `Example Co deck ${id}`,
  mimeType: 'application/vnd.google-apps.presentation',
  path: 'Example Co / Night Owl Route',
  modifiedTime: null,
  modifiedByEmail: null,
  createdTime: null,
  size: null,
  isFolder: false,
});

function ctxOf(apply: boolean) {
  return createIdeaScanContext({ accountExternalId: 'acct-root-1', accountName: 'Acme', apply });
}

beforeEach(() => {
  for (const m of Object.values(mocks))
    if (typeof m === 'function' && 'mockReset' in m) m.mockReset();
  mocks.tx.idea.create.mockReset();
  mocks.tx.ideaChange.create.mockReset();
  mocks.findMany.mockResolvedValue([]);
  mocks.matchAndMergeIdea.mockImplementation(async ({ newIdea }) => ({
    matchId: null,
    mergedFacets: newIdea.facets,
  }));
  // Interactive form runs the callback with tx; array form resolves the prepared ops.
  mocks.transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (t: typeof mocks.tx) => unknown)(mocks.tx) : arg,
  );
  mocks.tx.idea.create.mockImplementation(async () => ({ id: 'idea-new-1' }));
});

describe('createIdeaScanContext', () => {
  it('starts with zeroed stats and an unloaded cache', () => {
    const ctx = ctxOf(true);
    expect(ctx).toEqual({
      accountExternalId: 'acct-root-1',
      accountName: 'Acme',
      apply: true,
      stats: { deckFiles: 0, ideasCreated: 0, ideasUpdated: 0, ideasUnchanged: 0, ideaErrors: 0 },
      known: null,
    });
  });
});

describe('extractIdeaCandidates', () => {
  it('returns null for deckType "other" without calling the LLM or counting a deck file', async () => {
    const ctx = ctxOf(true);
    const res = await extractIdeaCandidates(ctx, {
      file: file('file-1'),
      text: 't',
      deckType: 'other',
    });
    expect(res).toBeNull();
    expect(mocks.extractIdeasFromFile).not.toHaveBeenCalled();
    expect(ctx.stats.deckFiles).toBe(0);
  });

  it('returns the extracted ideas for a pitch deck and increments deckFiles', async () => {
    const ideas = [{ name: 'Night Owl Route', facets: ['tongue in cheek'] }];
    mocks.extractIdeasFromFile.mockResolvedValueOnce({ deckType: 'pitch', ideas });
    const ctx = ctxOf(true);
    const f = file('file-1');
    const res = await extractIdeaCandidates(ctx, { file: f, text: 'deck text', deckType: 'pitch' });
    expect(res).toEqual(ideas);
    expect(ctx.stats.deckFiles).toBe(1);
    expect(ctx.stats.ideaErrors).toBe(0);
    expect(mocks.extractIdeasFromFile).toHaveBeenCalledWith({
      file: f,
      text: 'deck text',
      accountName: 'Acme',
    });
  });

  it('also extracts for creative_review decks', async () => {
    mocks.extractIdeasFromFile.mockResolvedValueOnce({ deckType: 'creative_review', ideas: [] });
    const ctx = ctxOf(true);
    const res = await extractIdeaCandidates(ctx, {
      file: file('file-1'),
      text: 't',
      deckType: 'creative_review',
    });
    expect(res).toEqual([]);
    expect(ctx.stats.deckFiles).toBe(1);
  });

  it('returns "failed" and counts ideaErrors when extraction throws, without throwing', async () => {
    mocks.extractIdeasFromFile.mockRejectedValueOnce(new Error('boom'));
    const ctx = ctxOf(true);
    const res = await extractIdeaCandidates(ctx, {
      file: file('file-1'),
      text: 't',
      deckType: 'pitch',
    });
    expect(res).toBe('failed');
    expect(ctx.stats.ideaErrors).toBe(1);
    expect(ctx.stats.deckFiles).toBe(1);
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
  });
});

describe('mergeIdeaCandidates', () => {
  it('does nothing (no DB read) for an empty idea list', async () => {
    const ctx = ctxOf(true);
    await mergeIdeaCandidates(ctx, { file: file('file-1'), campaignExternalId: null, ideas: [] });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(ctx.known).toBeNull();
  });

  it('loads the account ideas lazily ONCE per context, scoped to the account and ordered by createdAt asc', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'idea-old', name: 'Old', facets: ['a'], extra: 'dropped' },
    ]);
    const ctx = ctxOf(false);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: null,
      ideas: [{ name: 'One', facets: ['x'] }],
    });
    await mergeIdeaCandidates(ctx, {
      file: file('file-2'),
      campaignExternalId: null,
      ideas: [{ name: 'Two', facets: ['y'] }],
    });
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { accountExternalId: 'acct-root-1' },
      select: { id: true, name: true, facets: true },
      orderBy: { createdAt: 'asc' },
    });
    // The matcher saw the DB-loaded idea (mapped to id/name/facets only).
    expect(mocks.matchAndMergeIdea.mock.calls[0][0].existingIdeas[0]).toEqual({
      id: 'idea-old',
      name: 'Old',
      facets: ['a'],
    });
  });

  it('apply mode, new idea: one interactive transaction creates the idea and its birth change row', async () => {
    const ctx = ctxOf(true);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: 'camp-folder-1',
      ideas: [{ name: 'Night Owl Route', facets: ['a', 'b'] }],
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(typeof mocks.transaction.mock.calls[0][0]).toBe('function');
    expect(mocks.tx.idea.create).toHaveBeenCalledWith({
      data: {
        accountExternalId: 'acct-root-1',
        campaignExternalId: 'camp-folder-1',
        name: 'Night Owl Route',
        facets: ['a', 'b'],
        sourceFileId: 'file-1',
      },
    });
    expect(mocks.tx.ideaChange.create).toHaveBeenCalledWith({
      data: {
        ideaId: 'idea-new-1',
        property: 'facets',
        previousValueText: null,
        valueText: '- a\n- b',
        changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
      },
    });
    expect(ctx.stats.ideasCreated).toBe(1);
    expect(ctx.stats.ideaErrors).toBe(0);
    // The cache now carries the created idea under its real id.
    expect(ctx.known).toEqual([{ id: 'idea-new-1', name: 'Night Owl Route', facets: ['a', 'b'] }]);
  });

  it('omits campaignExternalId from the created row when it is null', async () => {
    const ctx = ctxOf(true);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: null,
      ideas: [{ name: 'Night Owl Route', facets: ['a'] }],
    });
    const data = mocks.tx.idea.create.mock.calls[0][0].data;
    expect(data).toEqual({
      accountExternalId: 'acct-root-1',
      name: 'Night Owl Route',
      facets: ['a'],
      sourceFileId: 'file-1',
    });
    expect('campaignExternalId' in data).toBe(false);
  });

  it('apply=false writes nothing; a later idea merges into the in-memory dryrun id (counted as updated)', async () => {
    mocks.matchAndMergeIdea
      .mockImplementationOnce(async ({ newIdea }) => ({
        matchId: null,
        mergedFacets: newIdea.facets,
      }))
      .mockImplementationOnce(async () => ({ matchId: 'dryrun:0', mergedFacets: ['a', 'b', 'c'] }));
    const ctx = ctxOf(false);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: null,
      ideas: [
        { name: 'Night Owl Route', facets: ['a', 'b'] },
        { name: 'Night Owl Route v2', facets: ['c'] },
      ],
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.ideaUpdate).not.toHaveBeenCalled();
    expect(mocks.tx.idea.create).not.toHaveBeenCalled();
    expect(ctx.stats).toMatchObject({
      ideasCreated: 1,
      ideasUpdated: 1,
      ideasUnchanged: 0,
      ideaErrors: 0,
    });
    // The second matcher call saw the first idea under its dryrun id.
    expect(mocks.matchAndMergeIdea.mock.calls[1][0].existingIdeas).toEqual([
      expect.objectContaining({ id: 'dryrun:0', name: 'Night Owl Route' }),
    ]);
    expect(ctx.known).toEqual([
      { id: 'dryrun:0', name: 'Night Owl Route', facets: ['a', 'b', 'c'] },
    ]);
  });

  it('names dryrun ids by the running created count (dryrun:0, dryrun:1)', async () => {
    const ctx = ctxOf(false);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: null,
      ideas: [
        { name: 'One', facets: ['a'] },
        { name: 'Two', facets: ['b'] },
      ],
    });
    expect(ctx.known?.map((k) => k.id)).toEqual(['dryrun:0', 'dryrun:1']);
    expect(ctx.stats.ideasCreated).toBe(2);
  });

  it('a merge whose facets equal the existing set (order and case-insensitive) is unchanged: no write', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'idea-1', name: 'Night Owl Route', facets: ['Tongue in cheek', 'social-first'] },
    ]);
    mocks.matchAndMergeIdea.mockResolvedValueOnce({
      matchId: 'idea-1',
      mergedFacets: ['SOCIAL-FIRST', 'tongue in cheek'],
    });
    const ctx = ctxOf(true);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: null,
      ideas: [{ name: 'Night Owl Route', facets: ['x'] }],
    });
    expect(ctx.stats).toMatchObject({ ideasUnchanged: 1, ideasUpdated: 0, ideasCreated: 0 });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.ideaUpdate).not.toHaveBeenCalled();
    // Cache keeps the original wording (no advance on a no-op).
    expect(ctx.known?.[0].facets).toEqual(['Tongue in cheek', 'social-first']);
  });

  it('apply mode, real merge: array transaction with idea update and a change row holding the OLD facets', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'idea-1', name: 'Night Owl Route', facets: ['old a', 'old b'] },
    ]);
    mocks.matchAndMergeIdea.mockResolvedValueOnce({
      matchId: 'idea-1',
      mergedFacets: ['old a', 'new c'],
    });
    mocks.ideaUpdate.mockReturnValue('UPDATE_OP');
    mocks.ideaChangeCreate.mockReturnValue('CHANGE_OP');
    const ctx = ctxOf(true);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: null,
      ideas: [{ name: 'Night Owl Route', facets: ['new c'] }],
    });
    expect(mocks.ideaUpdate).toHaveBeenCalledWith({
      where: { id: 'idea-1' },
      data: { facets: ['old a', 'new c'] },
    });
    expect(mocks.ideaChangeCreate).toHaveBeenCalledWith({
      data: {
        ideaId: 'idea-1',
        property: 'facets',
        previousValueText: '- old a\n- old b',
        valueText: '- old a\n- new c',
        changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
      },
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledWith(['UPDATE_OP', 'CHANGE_OP']);
    expect(ctx.stats).toMatchObject({ ideasUpdated: 1, ideasCreated: 0, ideasUnchanged: 0 });
    expect(ctx.known?.[0].facets).toEqual(['old a', 'new c']);
  });

  it('advances the in-memory cache: a second file sees the merged facets and logs them as the old value', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'idea-1', name: 'Night Owl Route', facets: ['v0'] }]);
    // The scan passes its live cache array and mutates it afterwards, so
    // snapshot what the matcher saw at call time.
    const seen: unknown[] = [];
    const merged = [['v1'], ['v2']];
    mocks.matchAndMergeIdea.mockImplementation(async ({ existingIdeas }) => {
      seen.push(structuredClone(existingIdeas));
      return { matchId: 'idea-1', mergedFacets: merged[seen.length - 1] };
    });
    mocks.ideaUpdate.mockReturnValue('U');
    mocks.ideaChangeCreate.mockReturnValue('C');
    const ctx = ctxOf(true);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: null,
      ideas: [{ name: 'Night Owl Route', facets: ['x'] }],
    });
    await mergeIdeaCandidates(ctx, {
      file: file('file-2'),
      campaignExternalId: null,
      ideas: [{ name: 'Night Owl Route', facets: ['y'] }],
    });
    // The matcher saw the advanced facets on the second call.
    expect(seen[0]).toEqual([{ id: 'idea-1', name: 'Night Owl Route', facets: ['v0'] }]);
    expect(seen[1]).toEqual([{ id: 'idea-1', name: 'Night Owl Route', facets: ['v1'] }]);
    expect(mocks.ideaChangeCreate.mock.calls[1][0].data).toMatchObject({
      previousValueText: '- v1',
      valueText: '- v2',
    });
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(ctx.stats.ideasUpdated).toBe(2);
  });

  it('apply=false merge into a DB idea updates memory and stats but writes nothing', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'idea-1', name: 'Night Owl Route', facets: ['old a'] },
    ]);
    mocks.matchAndMergeIdea.mockResolvedValueOnce({
      matchId: 'idea-1',
      mergedFacets: ['old a', 'new c'],
    });
    const ctx = ctxOf(false);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: null,
      ideas: [{ name: 'Night Owl Route', facets: ['new c'] }],
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.ideaUpdate).not.toHaveBeenCalled();
    expect(ctx.stats.ideasUpdated).toBe(1);
    expect(ctx.known?.[0].facets).toEqual(['old a', 'new c']);
  });

  it('falls back to creating the idea as new when the matcher throws', async () => {
    mocks.matchAndMergeIdea.mockRejectedValueOnce(new Error('llm down'));
    const ctx = ctxOf(true);
    await mergeIdeaCandidates(ctx, {
      file: file('file-1'),
      campaignExternalId: null,
      ideas: [{ name: 'Night Owl Route', facets: ['a', 'b'] }],
    });
    expect(mocks.tx.idea.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Night Owl Route',
        facets: ['a', 'b'],
        sourceFileId: 'file-1',
      }),
    });
    expect(ctx.stats).toMatchObject({ ideasCreated: 1, ideaErrors: 0 });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
  });

  it('counts a DB error in ideaErrors and never throws', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('db down'));
    const ctx = ctxOf(true);
    await expect(
      mergeIdeaCandidates(ctx, {
        file: file('file-1'),
        campaignExternalId: null,
        ideas: [{ name: 'Night Owl Route', facets: ['a'] }],
      }),
    ).resolves.toBeUndefined();
    expect(ctx.stats.ideaErrors).toBe(1);
    expect(ctx.stats.ideasCreated).toBe(0);
  });

  it('counts a failing initial findMany in ideaErrors and never throws', async () => {
    mocks.findMany.mockRejectedValueOnce(new Error('db down'));
    const ctx = ctxOf(true);
    await expect(
      mergeIdeaCandidates(ctx, {
        file: file('file-1'),
        campaignExternalId: null,
        ideas: [{ name: 'Night Owl Route', facets: ['a'] }],
      }),
    ).resolves.toBeUndefined();
    expect(ctx.stats.ideaErrors).toBe(1);
    expect(mocks.matchAndMergeIdea).not.toHaveBeenCalled();
  });
});
