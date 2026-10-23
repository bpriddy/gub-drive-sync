/**
 * Unit tests for idea-extraction.ts — the deck-gated, per-file idea extractor.
 * The LLM is a vi.fn; no real Gemini client is ever constructed.
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
// Replace the Gemini client so importing '../../ai' never builds a real one;
// parseLlmJson / SchemaType / DEFAULT_GEMINI_MODEL stay real.
vi.mock('../../ai/gemini.client', () => ({ defaultLlm: { complete: mocks.complete } }));

import { DEFAULT_GEMINI_MODEL } from '../../ai';
import { extractIdeasFromFile } from '../idea-extraction';
import type { TraversedFile } from '../types';

const file: TraversedFile = {
  id: 'file-1',
  name: 'Example Co - Round 2 Concepts',
  mimeType: 'application/vnd.google-apps.presentation',
  path: 'Example Co / Night Owl Route / Round 2',
  modifiedTime: null,
  modifiedByEmail: null,
  createdTime: null,
  size: null,
  isFolder: false,
};

function respond(payload: unknown): void {
  mocks.complete.mockResolvedValueOnce({ text: JSON.stringify(payload) });
}

describe('extractIdeasFromFile', () => {
  beforeEach(() => {
    mocks.complete.mockReset();
    mocks.loggerError.mockReset();
  });

  it('lets the gate win: deck_type "other" drops every listed idea', async () => {
    respond({
      deck_type: 'other',
      ideas: [{ name: 'Night Owl Route', facets: ['tongue in cheek'] }],
    });
    const res = await extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' });
    expect(res).toEqual({ deckType: 'other', ideas: [] });
  });

  it('passes ideas through for a pitch deck', async () => {
    respond({
      deck_type: 'pitch',
      ideas: [
        { name: 'Night Owl Route', facets: ['tongue in cheek', 'social-first'] },
        { name: 'Sunrise Relay', facets: ['leverages a seasonal hook'] },
      ],
    });
    const res = await extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' });
    expect(res.deckType).toBe('pitch');
    expect(res.ideas).toEqual([
      { name: 'Night Owl Route', facets: ['tongue in cheek', 'social-first'] },
      { name: 'Sunrise Relay', facets: ['leverages a seasonal hook'] },
    ]);
  });

  it('passes ideas through for a creative_review deck', async () => {
    respond({
      deck_type: 'creative_review',
      ideas: [{ name: 'Paper Lantern', facets: ['hand-made look'] }],
    });
    const res = await extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' });
    expect(res).toEqual({
      deckType: 'creative_review',
      ideas: [{ name: 'Paper Lantern', facets: ['hand-made look'] }],
    });
  });

  it('trims names and facets, drops empty facet strings and blank-named ideas', async () => {
    respond({
      deck_type: 'pitch',
      ideas: [
        {
          name: '  Night Owl Route  ',
          facets: ['  tongue in cheek ', '', '   ', 'social-first\n'],
        },
        { name: '   ', facets: ['orphan facet'] },
      ],
    });
    const res = await extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' });
    expect(res.ideas).toEqual([
      { name: 'Night Owl Route', facets: ['tongue in cheek', 'social-first'] },
    ]);
  });

  it('defaults missing facets to []', async () => {
    respond({ deck_type: 'pitch', ideas: [{ name: 'Night Owl Route' }] });
    const res = await extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' });
    expect(res.ideas).toEqual([{ name: 'Night Owl Route', facets: [] }]);
  });

  it('defaults missing ideas to []', async () => {
    respond({ deck_type: 'pitch' });
    const res = await extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' });
    expect(res).toEqual({ deckType: 'pitch', ideas: [] });
  });

  it('throws and logs an error on a non-JSON completion, capping raw at 400 chars', async () => {
    const garbage = 'not json at all '.repeat(100); // 1600 chars
    mocks.complete.mockResolvedValueOnce({ text: garbage });
    await expect(
      extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' }),
    ).rejects.toThrow();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [ctx, msg] = mocks.loggerError.mock.calls[0];
    expect(msg).toBe('[drive.idea-extraction] parse failed');
    expect(ctx.fileId).toBe('file-1');
    expect(ctx.raw).toHaveLength(400);
    expect(ctx.raw).toBe(garbage.slice(0, 400));
  });

  it('throws and logs on a schema-invalid completion (unknown deck_type)', async () => {
    respond({ deck_type: 'brief', ideas: [] });
    await expect(
      extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' }),
    ).rejects.toThrow();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });

  it('throws on a schema-invalid idea (empty name string)', async () => {
    respond({ deck_type: 'pitch', ideas: [{ name: '', facets: [] }] });
    await expect(
      extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' }),
    ).rejects.toThrow();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });

  it('calls the LLM with the pinned model, temperature, tag, token cap and a response schema', async () => {
    respond({ deck_type: 'other', ideas: [] });
    await extractIdeasFromFile({ file, text: 'body', accountName: 'Acme' });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    const req = mocks.complete.mock.calls[0][0];
    expect(req.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(req.temperature).toBe(0.2);
    expect(req.tag).toBe('drive.idea_extraction.v1');
    expect(req.maxOutputTokens).toBe(16384);
    expect(req.responseSchema).toMatchObject({
      required: ['deck_type', 'ideas'],
      properties: {
        deck_type: { enum: ['pitch', 'creative_review', 'other'] },
        ideas: { items: { required: ['name', 'facets'] } },
      },
    });
  });

  it('puts the file name, folder path, file text and account name in the prompt', async () => {
    respond({ deck_type: 'other', ideas: [] });
    await extractIdeasFromFile({ file, text: 'UNIQUE-DECK-BODY-123', accountName: 'Acme' });
    const prompt: string = mocks.complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('ACCOUNT: Acme');
    expect(prompt).toContain('FILE NAME: Example Co - Round 2 Concepts');
    expect(prompt).toContain('FOLDER PATH: Example Co / Night Owl Route / Round 2');
    expect(prompt).toContain('"""\nUNIQUE-DECK-BODY-123\n"""');
  });

  it('renders "(unknown)" when accountName is null', async () => {
    respond({ deck_type: 'other', ideas: [] });
    await extractIdeasFromFile({ file, text: 'body', accountName: null });
    expect(mocks.complete.mock.calls[0][0].prompt).toContain('ACCOUNT: (unknown)');
  });
});
