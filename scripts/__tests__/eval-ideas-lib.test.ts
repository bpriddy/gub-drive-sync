import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LlmCompletionRequest, LlmDriver } from '../../src/ai';
import {
  Budget,
  BudgetStop,
  DRIVER_ATTEMPTS,
  PRICE_PER_M_TOKENS,
  assign,
  chargeFor,
  costUsd,
  estimatePromptTokens,
  formatReport,
  guardDriver,
  isInside,
  isRunFile,
  loadFixtures,
  oneLine,
  parseArgs,
  parseGoldDeck,
  runMergeStage,
  score,
  scorePair,
  trigramSimilarity,
  worstCaseUsd,
  type CallRecord,
  type FixtureDeck,
  type GoldIdea,
  type RunFile,
} from '../eval-ideas-lib';

const EXAMPLE = path.join(__dirname, '..', 'eval-ideas-example');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ideas-'));
}

function gold(key: string, name: string, facets: string[] = [], aliases: string[] = []): GoldIdea {
  return { key, name, facets, aliases };
}

function emptyRun(decks: RunFile['decks'], decisions: RunFile['merge']['decisions'] = []): RunFile {
  return {
    version: 1,
    kind: 'eval-ideas-run',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    driver: 'test',
    model: 'test',
    maxUsd: 1,
    spentUsd: 0,
    stoppedByBudget: null,
    calls: [],
    decks,
    merge: { ran: decisions.length > 0, decisions, clusters: [] },
  };
}

function fixture(id: string, g: Partial<FixtureDeck['gold']> = {}): FixtureDeck {
  return { id, text: `${id} text`, gold: { deckType: 'pitch', ideas: [], ...g } };
}

describe('trigramSimilarity (pg_trgm similarity)', () => {
  it("matches pg_trgm's reference value: similarity('cat', 'cats') = 0.5", () => {
    expect(trigramSimilarity('cat', 'cats')).toBe(0.5);
  });

  it('ignores case, punctuation and accents; disjoint or empty text scores 0', () => {
    expect(trigramSimilarity('Night-Owl Route!', 'night owl route')).toBe(1);
    expect(trigramSimilarity('Café', 'cafe')).toBe(1);
    expect(trigramSimilarity('owl', 'zebra')).toBe(0);
    expect(trigramSimilarity('', 'owl')).toBe(0);
    expect(trigramSimilarity('...', '!!!')).toBe(0);
  });
});

describe('scorePair', () => {
  it('takes the best of the gold name and its aliases', () => {
    const g = gold('k', 'Night Owl Route', [], ['The Night Owl']);
    expect(scorePair({ name: 'The Night Owl', facets: [] }, g).name).toBe(1);
  });

  it('scores a renamed idea through its facets when the names differ', () => {
    const g = gold('k', 'Pocket Postcards', ['illustrated postcards in every cup sleeve']);
    const s = scorePair(
      { name: 'Sleeve Notes', facets: ['illustrated postcards in every cup sleeve'] },
      g,
    );
    expect(s.name).toBeLessThan(0.4);
    expect(s.facets).toBe(1);
    expect(s.score).toBe(1);
  });

  it('gives no facet score when either side has no facets', () => {
    expect(scorePair({ name: 'x', facets: [] }, gold('k', 'y', ['a facet'])).facets).toBe(0);
  });
});

describe('assign', () => {
  it('pairs one-to-one, best score first, and counts a second hit on a taken gold idea as a duplicate', () => {
    const golds = [gold('a', 'Night Owl Route'), gold('b', 'Kitchen Table Stories')];
    const extracted = [
      { name: 'Night Owl', facets: [] },
      { name: 'Night Owl Route', facets: [] },
      { name: 'Kitchen Table Stories', facets: [] },
    ];
    const a = assign(extracted, golds, 0.4);
    expect([...a.hits]).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(a.duplicates).toEqual([0]);
  });

  it('counts a pair exactly at the threshold as a hit', () => {
    const a = assign([{ name: 'cat', facets: [] }], [gold('k', 'cats')], 0.5);
    expect(a.hits.get(0)).toBe(0);
    expect(assign([{ name: 'cat', facets: [] }], [gold('k', 'cats')], 0.51).hits.size).toBe(0);
  });
});

describe('parseGoldDeck', () => {
  it('fills the defaults', () => {
    expect(parseGoldDeck('d', { deckType: 'other' })).toEqual({ deckType: 'other', ideas: [] });
  });

  it('rejects an "other" deck that lists ideas', () => {
    expect(() =>
      parseGoldDeck('d', { deckType: 'other', ideas: [{ key: 'k', name: 'n' }] }),
    ).toThrow('d.gold.json: deckType "other" cannot list ideas');
  });

  it('rejects a key used twice in one deck', () => {
    const ideas = [
      { key: 'k', name: 'one' },
      { key: 'k', name: 'two' },
    ];
    expect(() => parseGoldDeck('d', { deckType: 'pitch', ideas })).toThrow('key "k" appears twice');
  });

  it('rejects unknown fields and deck types, naming the path', () => {
    expect(() => parseGoldDeck('d', { deckType: 'pitch', idea: [] })).toThrow(
      /d\.gold\.json: .*idea/,
    );
    expect(() => parseGoldDeck('d', { deckType: 'brief' })).toThrow(/d\.gold\.json: deckType/);
  });
});

describe('loadFixtures', () => {
  it('loads the bundled synthetic example in merge order', () => {
    const decks = loadFixtures(EXAMPLE);
    expect(decks.map((d) => d.id)).toEqual(['deck-01', 'deck-02', 'deck-03', 'deck-04']);
    expect(decks[0]!.gold.ideas.map((i) => i.key)).toEqual(['night-owl', 'kitchen-table']);
    expect(decks[0]!.text).toContain('Night Owl Route');
  });

  it('sorts by account, then order, then id', () => {
    const dir = tmpDir();
    const put = (id: string, g: object) => {
      fs.writeFileSync(path.join(dir, `${id}.txt`), 'text');
      fs.writeFileSync(
        path.join(dir, `${id}.gold.json`),
        JSON.stringify({ deckType: 'other', ...g }),
      );
    };
    put('a', { account: 'Zeta', order: 1 });
    put('b', { account: 'Alpha', order: 2 });
    put('c', { account: 'Alpha', order: 1 });
    put('d', { account: 'Alpha' });
    expect(loadFixtures(dir).map((d) => d.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('refuses a half-annotated set and an empty one', () => {
    const dir = tmpDir();
    expect(() => loadFixtures(dir)).toThrow('no *.gold.json files');
    fs.writeFileSync(path.join(dir, 'x.txt'), 'text');
    fs.writeFileSync(path.join(dir, 'y.gold.json'), '{"deckType":"other"}');
    expect(() => loadFixtures(dir)).toThrow(
      /y\.gold\.json has no y\.txt; x\.txt has no x\.gold\.json/,
    );
  });
});

describe('score', () => {
  it('scores the synthetic sample run', () => {
    const run = JSON.parse(
      fs.readFileSync(path.join(EXAMPLE, 'sample-run.json'), 'utf8'),
    ) as RunFile;
    const r = score(loadFixtures(EXAMPLE), run, 0.4);
    expect(r.extraction).toMatchObject({
      gold: 5,
      extracted: 7,
      hits: 5,
      recall: 1,
      duplicates: 1,
    });
    expect(r.extraction.precision).toBeCloseTo(5 / 7);
    expect(r.deckType).toMatchObject({ accuracy: 1, missedIdeaDecks: 0, falseIdeaDecks: 0 });
    // deck-04's distinct idea merged into the night-owl row: a false merge and an impure row;
    // deck-02's duplicate extraction has no gold idea, so its merge is unscored.
    expect(r.merge).toMatchObject({
      scoredMerges: 2,
      correctMerges: 1,
      falseMerges: 1,
      falseMergeRate: 0.5,
      unscoredMerges: 1,
      missedMerges: 0,
      duplicateRows: 0,
      impureRows: 1,
      nearDuplicateFacetPairs: 1,
    });
    expect(r.perDeck[0]!.spurious).toEqual([
      expect.objectContaining({ extracted: 'Coffee that keeps night workers going' }),
    ]);
  });

  it('counts the gate in both directions and leaves failed decks out of the confusion', () => {
    const fixtures = [
      fixture('idea', { ideas: [gold('k', 'Night Owl Route')] }),
      fixture('plan', { deckType: 'other' }),
      fixture('broken', { ideas: [gold('j', 'Kitchen Table Stories')] }),
    ];
    const r = score(
      fixtures,
      emptyRun([
        { id: 'idea', deckType: 'other', ideas: [], error: null },
        { id: 'plan', deckType: 'pitch', ideas: [{ name: 'Media mix', facets: [] }], error: null },
        { id: 'broken', deckType: null, ideas: [], error: 'ZodError: bad json' },
      ]),
      0.4,
    );
    expect(r.deckType).toEqual({
      accuracy: 0,
      gateAccuracy: 0,
      confusion: { 'pitch->other': 1, 'other->pitch': 1 },
      missedIdeaDecks: 1,
      falseIdeaDecks: 1,
    });
    expect(r.extractionErrors).toBe(1);
    expect(r.extraction).toMatchObject({
      gold: 2,
      extracted: 1,
      hits: 0,
      precision: 0,
      recall: 0,
      f1: null,
    });
  });

  it('counts a create for an idea the account already holds as a missed merge and a duplicate row', () => {
    const fixtures = [
      fixture('d1', { account: 'A', ideas: [gold('k', 'Night Owl Route')] }),
      fixture('d2', { account: 'A', ideas: [gold('k', 'Night Owl Route')] }),
      fixture('d3', { account: 'B', ideas: [gold('k', 'Night Owl Route')] }),
    ];
    const idea = { name: 'Night Owl Route', facets: [] };
    const run = emptyRun(
      fixtures.map((f) => ({ id: f.id, deckType: 'pitch' as const, ideas: [idea], error: null })),
      [
        { account: 'A', deckId: 'd1', ideaIndex: 0, clusterId: 'row-1', action: 'create' },
        { account: 'A', deckId: 'd2', ideaIndex: 0, clusterId: 'row-2', action: 'create' },
        // Another account's row for the same key is not a missed merge: the matcher is per account.
        { account: 'B', deckId: 'd3', ideaIndex: 0, clusterId: 'row-3', action: 'create' },
      ],
    );
    expect(score(fixtures, run, 0.4).merge).toMatchObject({
      missedMerges: 1,
      duplicateRows: 1,
      falseMergeRate: null,
    });
  });

  it('lists near misses for unmatched extractions only, and scores the gate apart from the label', () => {
    const fixtures = [fixture('d1', { deckType: 'creative_review', ideas: [gold('k', 'cats')] })];
    const r = score(
      fixtures,
      emptyRun([
        { id: 'd1', deckType: 'pitch', ideas: [{ name: 'cat', facets: [] }], error: null },
      ]),
      0.6, // 'cat' vs 'cats' = 0.5: below the threshold, inside the 0.15 band
    );
    expect(r.extraction.nearMisses).toEqual([
      { deckId: 'd1', extracted: 'cat', gold: 'cats', score: 0.5 },
    ]);
    expect(r.deckType).toMatchObject({ accuracy: 0, gateAccuracy: 1 });
  });

  it('refuses a run with decks the fixtures lack', () => {
    expect(() =>
      score(
        [fixture('d1')],
        emptyRun([{ id: 'gone', deckType: 'pitch', ideas: [], error: null }]),
        0.4,
      ),
    ).toThrow('run has decks the fixtures lack: gone');
  });

  it('prints the headline numbers', () => {
    const run = JSON.parse(
      fs.readFileSync(path.join(EXAMPLE, 'sample-run.json'), 'utf8'),
    ) as RunFile;
    const text = formatReport(score(loadFixtures(EXAMPLE), run, 0.4));
    expect(text).toContain('precision 71.4%, recall 100.0%');
    expect(text).toContain('false-merge rate 50.0% (1 of 2 scored, 1 unscored)');
  });
});

describe('prices and the spend guard', () => {
  it('prices thoughts as output', () => {
    expect(costUsd({ promptTokens: 1_000_000, outputTokens: 0, thoughtsTokens: 0 })).toBe(
      PRICE_PER_M_TOKENS.input,
    );
    expect(costUsd({ promptTokens: 0, outputTokens: 0, thoughtsTokens: 1_000_000 })).toBe(
      PRICE_PER_M_TOKENS.output,
    );
  });

  it('over-estimates prompt tokens at one per 3 UTF-8 bytes', () => {
    expect(estimatePromptTokens('abcdef')).toBe(2);
    expect(estimatePromptTokens('ж'.repeat(3))).toBe(2); // 6 bytes
    expect(worstCaseUsd('abc', 1_000_000)).toBeCloseTo(PRICE_PER_M_TOKENS.output + 1.5e-6);
  });

  function driver(impl: LlmDriver['complete']) {
    const inner = vi.fn(impl);
    const llm: LlmDriver = { name: 'gemini', complete: inner };
    return { llm, inner };
  }
  const req = (prompt = 'x'.repeat(300)): LlmCompletionRequest => ({
    model: 'm',
    temperature: 0,
    prompt,
    tag: 't',
    maxOutputTokens: 1_000,
  });

  it('refuses a call whose worst case does not fit, before calling the model', async () => {
    const { llm, inner } = driver(async () => ({ text: '{}', driver: 'gemini', model: 'm' }));
    const calls: CallRecord[] = [];
    guardDriver(llm, new Budget(0.005), calls, false); // worst case of req() is ~$0.00915
    await expect(llm.complete(req())).rejects.toBeInstanceOf(BudgetStop);
    expect(inner).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('charges the reported usage of a successful call', async () => {
    const usage = { promptTokens: 100, outputTokens: 50, thoughtsTokens: 150, totalTokens: 300 };
    const { llm } = driver(async () => ({ text: '{}', driver: 'gemini', model: 'm', usage }));
    const budget = new Budget(1);
    const calls: CallRecord[] = [];
    guardDriver(llm, budget, calls, false);
    await llm.complete(req());
    const expected = (100 * 1.5 + 200 * 9) / 1_000_000;
    expect(budget.spentUsd).toBeCloseTo(expected);
    expect(calls).toEqual([
      expect.objectContaining({
        tag: 't',
        ok: true,
        promptTokens: 100,
        thoughtsTokens: 150,
        usd: expected,
      }),
    ]);
  });

  it('charges the worst case when a call reports no usage, and every driver attempt when it fails', async () => {
    const worst = worstCaseUsd(req().prompt, 1_000);
    const noUsage = driver(async () => ({ text: '{}', driver: 'gemini', model: 'm' }));
    const b1 = new Budget(1);
    guardDriver(noUsage.llm, b1, [], false);
    await noUsage.llm.complete(req());
    expect(b1.spentUsd).toBeCloseTo(worst);

    const failing = driver(async () => {
      throw new Error('503');
    });
    const b2 = new Budget(1);
    const calls: CallRecord[] = [];
    guardDriver(failing.llm, b2, calls, false);
    await expect(failing.llm.complete(req())).rejects.toThrow('503');
    expect(b2.spentUsd).toBeCloseTo(worst * DRIVER_ATTEMPTS);
    expect(calls[0]).toMatchObject({ ok: false, usd: worst * DRIVER_ATTEMPTS });
  });

  it('lets a call through when its worst case fills the cap exactly', async () => {
    const worst = worstCaseUsd(req().prompt, 1_000);
    const { llm, inner } = driver(async () => ({ text: '{}', driver: 'gemini', model: 'm' }));
    guardDriver(llm, new Budget(worst), [], false);
    await llm.complete(req());
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('chargeFor pays for thoughts it was not told about, and falls back to the worst case', () => {
    // total - prompt (900) beats output + missing thoughts (100).
    const viaTotal = {
      promptTokens: 100,
      outputTokens: 100,
      thoughtsTokens: null,
      totalTokens: 1_000,
    };
    expect(chargeFor(viaTotal, 9)).toBeCloseTo((100 * 1.5 + 900 * 9) / 1_000_000);
    const noOutputSide = {
      promptTokens: 100,
      outputTokens: null,
      thoughtsTokens: null,
      totalTokens: null,
    };
    expect(chargeFor(noOutputSide, 9)).toBe(9);
    expect(chargeFor(undefined, 9)).toBe(9);
  });

  it('stops once the spend leaves no room for the next worst case', async () => {
    const usage = { promptTokens: 100, outputTokens: 900, thoughtsTokens: 0, totalTokens: 1000 };
    const { llm, inner } = driver(async () => ({
      text: '{}',
      driver: 'gemini',
      model: 'm',
      usage,
    }));
    // Each call: worst ~$0.00915, actual $0.00825.
    guardDriver(llm, new Budget(0.02), [], false);
    await llm.complete(req());
    await llm.complete(req());
    await expect(llm.complete(req())).rejects.toThrow(/stopping under --max-usd 0.02/);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('charges nothing on the mock driver', async () => {
    const { llm } = driver(async () => ({ text: '{}', driver: 'mock', model: 'm' }));
    const budget = new Budget(0.000001);
    guardDriver(llm, budget, [], true);
    await llm.complete(req());
    expect(budget.spentUsd).toBe(0);
  });
});

describe('runMergeStage', () => {
  const setEqual = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.includes(x));

  it('keeps one known list per account and records create / update / noop in deck order', async () => {
    const decks = [
      fixture('a1', { account: 'A' }),
      fixture('a2', { account: 'A' }),
      fixture('b1', { account: 'B' }),
    ];
    const run = emptyRun([
      { id: 'a1', deckType: 'pitch', ideas: [{ name: 'Owl', facets: ['radio'] }], error: null },
      {
        id: 'a2',
        deckType: 'pitch',
        ideas: [
          { name: 'Owl II', facets: ['radio', 'podcast'] },
          { name: 'Owl III', facets: ['podcast', 'radio'] },
        ],
        error: null,
      },
      { id: 'b1', deckType: 'pitch', ideas: [{ name: 'Owl', facets: ['radio'] }], error: null },
    ]);
    const seen: number[] = [];
    const matchAndMergeIdea = vi.fn(
      async ({ existingIdeas }: { existingIdeas: { id: string }[] }) => {
        seen.push(existingIdeas.length);
        if (existingIdeas.length === 0) return { matchId: null, mergedFacets: ['radio'] };
        return { matchId: existingIdeas[0]!.id, mergedFacets: ['radio', 'podcast'] };
      },
    );
    const onDecision = vi.fn();
    await runMergeStage({ matchAndMergeIdea, facetsEqual: setEqual }, decks, run, onDecision);
    expect(seen).toEqual([0, 1, 1, 0]); // account B starts from an empty list
    expect(onDecision).toHaveBeenCalledTimes(4); // the caller checkpoints after every decision
    expect(matchAndMergeIdea.mock.calls[3]![0]).toMatchObject({
      newIdea: { name: 'Owl', facets: ['radio'] },
      accountName: 'B',
    });
    expect(
      run.merge.decisions.map((d) => `${d.deckId}#${d.ideaIndex}:${d.action}:${d.clusterId}`),
    ).toEqual(['a1#0:create:row-1', 'a2#0:update:row-1', 'a2#1:noop:row-1', 'b1#0:create:row-2']);
    expect(run.merge.clusters[0]).toEqual({
      id: 'row-1',
      account: 'A',
      name: 'Owl',
      facets: ['radio', 'podcast'],
    });
  });

  it('creates the idea as new when the matcher fails, and stops on BudgetStop', async () => {
    const decks = [fixture('d1')];
    const run = emptyRun([
      {
        id: 'd1',
        deckType: 'pitch',
        ideas: [
          { name: 'One', facets: ['f1'] },
          { name: 'Two', facets: ['f2'] },
          { name: 'Three', facets: ['f3'] },
        ],
        error: null,
      },
    ]);
    const matchAndMergeIdea = vi
      .fn()
      .mockResolvedValueOnce({ matchId: null, mergedFacets: ['f1'] })
      .mockRejectedValueOnce(new Error('parse failed'))
      .mockRejectedValueOnce(new BudgetStop(0.5, 0.2, 0.6));
    await runMergeStage({ matchAndMergeIdea, facetsEqual: setEqual }, decks, run);
    expect(run.merge.decisions.map((d) => d.action)).toEqual([
      'create',
      'create_after_match_error',
    ]);
    expect(run.merge.clusters[1]).toMatchObject({ name: 'Two', facets: ['f2'] });
    expect(run.stoppedByBudget).toMatch(/stopping under --max-usd 0.6/);
  });
});

describe('helpers', () => {
  it('isInside: the dir itself and anything below it, not a sibling', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
  });

  it('isInside resolves a symlink that points into the parent', () => {
    const root = tmpDir();
    const inner = path.join(root, 'repo', 'data');
    fs.mkdirSync(inner, { recursive: true });
    const link = path.join(root, 'outside-link');
    fs.symlinkSync(inner, link);
    expect(isInside(link, path.join(root, 'repo'))).toBe(true);
  });

  it('isInside resolves a path that does not exist yet under a symlink, and treats "..x" as a name', () => {
    const root = tmpDir();
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    const link = path.join(root, 'link');
    fs.symlinkSync(path.join(repo, 'scripts'), link);
    expect(isInside(path.join(link, 'new', 'dir'), repo)).toBe(true);
    expect(isInside(path.join(repo, '..secret'), repo)).toBe(true);
    expect(isInside(path.join(root, 'elsewhere', 'new'), repo)).toBe(false);
  });

  it('isRunFile checks the outer shape', () => {
    expect(isRunFile(emptyRun([]))).toBe(true);
    expect(isRunFile({ kind: 'eval-ideas-run', version: 1, decks: [] })).toBe(false);
    expect(isRunFile(null)).toBe(false);
  });

  it('oneLine collapses an error to one capped line', () => {
    expect(oneLine(new Error('a\n  b'))).toBe('Error: a b');
    expect(oneLine('x'.repeat(400))).toHaveLength(300);
  });
});

describe('parseArgs', () => {
  const env = {} as NodeJS.ProcessEnv;
  const base = ['--fixtures', '/x/gold'];

  it('parses a paid extract run and defaults the rest', () => {
    const a = parseArgs(['extract', ...base, '--out', '/x/out', '--max-usd', '3'], env);
    expect(a).toMatchObject({
      mode: 'extract',
      fixtures: '/x/gold',
      out: '/x/out',
      maxUsd: 3,
      limit: null,
      merge: true,
      plan: false,
      allowMock: false,
      threshold: 0.4,
    });
  });

  it('needs --max-usd and --out for a paid extract, neither for --plan', () => {
    expect(() => parseArgs(['extract', ...base, '--out', '/x/out'], env)).toThrow(
      'needs --max-usd',
    );
    expect(() => parseArgs(['extract', ...base, '--max-usd', '1'], env)).toThrow('needs --out');
    expect(parseArgs(['extract', ...base, '--plan'], env).plan).toBe(true);
    expect(() => parseArgs(['score', ...base], env)).toThrow('score needs --run');
  });

  it('refuses typos, missing values and values that look like flags', () => {
    expect(() => parseArgs(['extract', ...base, '--plna'], env)).toThrow('unknown argument --plna');
    expect(() => parseArgs(['extract', ...base, '--out', '--max-usd', '3'], env)).toThrow(
      '--out needs a value',
    );
    expect(() => parseArgs(['extract', ...base, '--limit'], env)).toThrow('--limit needs a value');
    expect(() => parseArgs(['extract', ...base, '--plan', '--max-usd', 'abc'], env)).toThrow(
      'must be a number',
    );
    expect(() => parseArgs(['extract', ...base, '--plan', '--max-usd', '0'], env)).toThrow(
      'positive',
    );
    expect(() => parseArgs(['run', ...base], env)).toThrow('first argument');
  });

  it('reads the env stand-ins, and treats an empty one as unset', () => {
    const a = parseArgs(['extract', '--plan'], {
      EVAL_IDEAS_FIXTURES: '/x/gold',
      EVAL_IDEAS_OUT: '',
    });
    expect(a).toMatchObject({ fixtures: '/x/gold', out: null });
    expect(() => parseArgs(['extract', '--plan'], { EVAL_IDEAS_FIXTURES: '' })).toThrow(
      '--fixtures <dir>',
    );
  });
});
