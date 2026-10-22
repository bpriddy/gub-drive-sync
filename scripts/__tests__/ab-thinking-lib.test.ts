/** The pure parts of the thinking A/B: cost, budget, selection, comparison, verdict. */
import { describe, expect, it } from 'vitest';
import {
  Budget,
  compareShapes,
  costUsd,
  distillShape,
  estimateCellUsd,
  interpretShape,
  parseJsonLoose,
  selectEvenly,
  summarize,
  verdict,
  type CellResult,
} from '../ab-thinking-lib';

const tokens = (promptTokens: number, outputTokens: number, thoughtsTokens: number) => ({
  promptTokens,
  outputTokens,
  thoughtsTokens,
});

describe('cost', () => {
  it('bills thoughts as output: $1.50 / $9.00 per 1M tokens', () => {
    expect(costUsd(tokens(1_000_000, 0, 0))).toBeCloseTo(1.5);
    expect(costUsd(tokens(0, 500_000, 500_000))).toBeCloseTo(9);
    expect(costUsd(tokens(12_000, 650, 3_750))).toBeCloseTo(0.0576);
  });

  it("estimates a cell from the captured call's tokens, or from its prompt length", () => {
    const captured = {
      prompt: 'x',
      result: { usage: { promptTokens: 12_000, outputTokens: 650, thoughtsTokens: 3_750 } },
    };
    expect(estimateCellUsd(captured)).toBeCloseTo(0.0576);
    expect(estimateCellUsd({ prompt: 'x'.repeat(40_000), result: { usage: null } })).toBeCloseTo(
      costUsd(tokens(10_000, 8_000, 0)),
    );
  });
});

describe('budget and selection', () => {
  it('runs a cell only while its estimate fits under the cap', () => {
    const b = new Budget(1);
    expect(b.allows(0.6)).toBe(true);
    b.add(0.6);
    expect(b.allows(0.5)).toBe(false);
    expect(b.allows(0.4)).toBe(true);
  });

  it('spreads the selection evenly over the captured records', () => {
    expect(selectEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([0, 3, 6]);
    expect(selectEvenly([1, 2], 5)).toEqual([1, 2]);
    expect(selectEvenly([1, 2], 0)).toEqual([]);
  });
});

describe('answers', () => {
  it('reads JSON with or without a fence, and gives up on a fragment', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here: {"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('{"a":"cut')).toBeUndefined();
  });

  it('keys interpret answers by deck type and campaign routing, not by wording', () => {
    const shape = interpretShape({
      deck_type: 'pitch',
      account: [{}, {}],
      campaign: [
        { entity_campaign_name: ' Spring Launch ' },
        { entity_campaign_name: 'spring launch' },
        { entity_campaign_name: null },
      ],
    });
    expect(shape).toEqual({
      valid: true,
      items: 5,
      keys: ['deck:pitch', 'campaign:spring launch'],
    });
  });

  it('keys distill answers by field and proposed value', () => {
    expect(
      distillShape({
        field_changes: [
          { field: 'status', proposed_value: 'live' },
          { field: 'ends_at', proposed_value: null },
        ],
        notes: [{}],
      }),
    ).toEqual({ valid: true, items: 3, keys: ['status="live"', 'ends_at=null'] });
  });

  it('compares field changes with the default arm', () => {
    const base = { valid: true, items: 3, keys: ['status="live"', 'budget="10"'] };
    const arm = { valid: true, items: 2, keys: ['status="live"', 'ends_at="2026-11-01"'] };
    expect(compareShapes(base, arm)).toEqual({
      itemsDelta: -1,
      keysLost: ['budget="10"'],
      keysAdded: ['ends_at="2026-11-01"'],
    });
  });
});

describe('summary and verdict', () => {
  const cell = (over: Partial<CellResult>): CellResult => ({
    kind: 'distill',
    arm: 'default',
    recordIndex: 0,
    ok: true,
    error: null,
    latencyMs: 1000,
    tokens: tokens(10_000, 500, 4_000),
    usd: 0.05,
    shape: { valid: true, items: 10, keys: ['status="live"'] },
    ...over,
  });

  it('passes an arm with valid answers, items within 10% and no lost field change', () => {
    const cells = [
      cell({}),
      cell({
        arm: 'LOW',
        tokens: tokens(10_000, 500, 1_000),
        shape: { valid: true, items: 10, keys: ['status="live"'] },
      }),
    ];
    const s = summarize(cells);
    expect(s.find((x) => x.arm === 'LOW')).toMatchObject({
      cells: 1,
      validShare: 1,
      pairedRecords: 1,
      pairedItems: 10,
      pairedBaseItems: 10,
      recordsLosingKeys: 0,
    });
    expect(verdict(s)).toEqual([
      'distill LOW: PASS (valid 100%, items 10 vs 10 over 1 paired record(s), records losing a key 0 (allowed 1), output+thoughts 67% below default)',
    ]);
  });

  it('flags an arm that loses items, a field change or validity', () => {
    const cells = [
      cell({}),
      cell({ recordIndex: 1 }),
      cell({ arm: 'MINIMAL', shape: { valid: true, items: 8, keys: [] } }),
      cell({ arm: 'MINIMAL', recordIndex: 1, shape: { valid: false, items: 0, keys: [] } }),
    ];
    const [line] = verdict(summarize(cells));
    expect(line).toMatch(
      /^distill MINIMAL: CHECK \(valid 50%, items 8 vs 20 over 2 paired record\(s\), records losing a key 2/,
    );
  });

  it('compares only records both arms have, so a budget stop cannot skew the totals', () => {
    const cells = [
      cell({}),
      cell({ recordIndex: 1, shape: { valid: true, items: 30, keys: [] } }),
      // The budget ran out before record 1 reached the LOW arm.
      cell({ arm: 'LOW', shape: { valid: true, items: 10, keys: ['status="live"'] } }),
    ];
    const low = summarize(cells).find((x) => x.arm === 'LOW');
    expect(low).toMatchObject({ pairedRecords: 1, pairedItems: 10, pairedBaseItems: 10 });
    expect(verdict(summarize(cells))[0]).toMatch(/^distill LOW: PASS/);
  });

  it('allows one losing record in ten', () => {
    const cells: CellResult[] = [];
    for (let i = 0; i < 20; i++) {
      cells.push(cell({ recordIndex: i, shape: { valid: true, items: 1, keys: ['k'] } }));
      cells.push(
        cell({
          arm: 'LOW',
          recordIndex: i,
          shape: { valid: true, items: 1, keys: i < 2 ? [] : ['k'] },
        }),
      );
    }
    const [line] = verdict(summarize(cells));
    expect(line).toMatch(/^distill LOW: PASS/);
    expect(line).toMatch(/records losing a key 2 \(allowed 2\)/);
  });
});
