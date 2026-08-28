/**
 * Hermetic suite for insight-asof.ts (D6 #42).
 *
 * The op-log is synthetic: a hand-built add → update → update → supersede
 * timeline whose active set at every cutoff is hand-derived, replayed
 * through the injected `loadChanges` seam (a fake that filters + orders
 * exactly like the SQL loader). No prisma, no network. The module boundary
 * mocks below only neutralize import-time side effects.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../prisma', () => ({ prisma: {} }));

import {
  insightsAsOf,
  replayInsightChanges,
  type AsOfInsight,
  type InsightChangeRow,
  type loadInsightChanges,
} from '../insight-asof';

const CAMPAIGN_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

// uuidv7-shaped ids, crafted so lexicographic order == mint order.
const INSIGHT_A = '01000000-0000-7000-8000-00000000000a';
const INSIGHT_B = '02000000-0000-7000-8000-00000000000b';
const INSIGHT_C = '03000000-0000-7000-8000-00000000000c';

const T1 = new Date('2026-06-01T00:00:00.000Z'); // ADD A
const T2 = new Date('2026-06-10T00:00:00.000Z'); // ADD B
const T3 = new Date('2026-07-01T00:00:00.000Z'); // UPDATE A (first)
const T4 = new Date('2026-07-05T00:00:00.000Z'); // UPDATE A (second)
const T5 = new Date('2026-07-15T00:00:00.000Z'); // SUPERSEDE A → C
const T6 = new Date('2026-08-01T00:00:00.000Z'); // UPDATE B
const NOW = new Date('2026-08-28T12:00:00.000Z');

const A_TEXT_V1 = 'Launch is planned for May.';
const A_TEXT_V2 = 'Launch shifted from May to June 1.';
const A_TEXT_V3 = 'Launch shifted again to June 3.';
const B_TEXT_V1 = 'Budget is $50k.';
const B_TEXT_V2 = 'Budget raised to $75k.';
const C_TEXT = 'Launch happened June 3; the campaign is live.';

function row(
  over: Partial<InsightChangeRow> &
    Pick<InsightChangeRow, 'changeId' | 'insightId' | 'op' | 'createdAt'>,
): InsightChangeRow {
  return { newText: null, replacementId: null, ...over };
}

/** The synthetic op-log, deliberately NOT in chronological array order —
 * the fake loader must impose the SQL's (created_at, id) ordering. */
const OP_LOG: InsightChangeRow[] = [
  row({
    changeId: 'c6000000-0000-7000-8000-000000000006',
    insightId: INSIGHT_B,
    op: 'UPDATE',
    newText: B_TEXT_V2,
    createdAt: T6,
  }),
  row({
    changeId: 'c1000000-0000-7000-8000-000000000001',
    insightId: INSIGHT_A,
    op: 'ADD',
    newText: A_TEXT_V1,
    createdAt: T1,
  }),
  row({
    changeId: 'c5000000-0000-7000-8000-000000000005',
    insightId: INSIGHT_A,
    op: 'SUPERSEDE',
    newText: C_TEXT,
    replacementId: INSIGHT_C,
    createdAt: T5,
  }),
  row({
    changeId: 'c3000000-0000-7000-8000-000000000003',
    insightId: INSIGHT_A,
    op: 'UPDATE',
    newText: A_TEXT_V2,
    createdAt: T3,
  }),
  row({
    changeId: 'c2000000-0000-7000-8000-000000000002',
    insightId: INSIGHT_B,
    op: 'ADD',
    newText: B_TEXT_V1,
    createdAt: T2,
  }),
  row({
    changeId: 'c4000000-0000-7000-8000-000000000004',
    insightId: INSIGHT_A,
    op: 'UPDATE',
    newText: A_TEXT_V3,
    createdAt: T4,
  }),
];

/** Filters + orders like loadInsightChanges' SQL: created_at <= at,
 * ORDER BY created_at ASC, id ASC. */
function fakeLoader(log: InsightChangeRow[]): typeof loadInsightChanges {
  return async (_scope, at) =>
    log
      .filter((r) => r.createdAt.getTime() <= at.getTime())
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0),
      );
}

function asOf(at: Date, log: InsightChangeRow[] = OP_LOG): Promise<AsOfInsight[]> {
  return insightsAsOf('campaign', CAMPAIGN_ID, at, { loadChanges: fakeLoader(log) });
}

function texts(set: AsOfInsight[]): Record<string, string> {
  return Object.fromEntries(set.map((i) => [i.id, i.text]));
}

describe('insightsAsOf — replay at historical dates', () => {
  it('returns the empty set before any op', async () => {
    expect(await asOf(new Date('2026-05-01T00:00:00.000Z'))).toEqual([]);
  });

  it('cutoff is inclusive: replay AT the first ADD sees it', async () => {
    expect(texts(await asOf(T1))).toEqual({ [INSIGHT_A]: A_TEXT_V1 });
  });

  it('date 1 — after both ADDs: original texts', async () => {
    expect(texts(await asOf(new Date('2026-06-15T00:00:00.000Z')))).toEqual({
      [INSIGHT_A]: A_TEXT_V1,
      [INSIGHT_B]: B_TEXT_V1,
    });
  });

  it('date 2 — between the two UPDATEs: lands on the intermediate text, not the latest', async () => {
    expect(texts(await asOf(new Date('2026-07-03T00:00:00.000Z')))).toEqual({
      [INSIGHT_A]: A_TEXT_V2,
      [INSIGHT_B]: B_TEXT_V1,
    });
  });

  it('date 3 — after the SUPERSEDE: target gone, replacement active, B untouched', async () => {
    expect(texts(await asOf(new Date('2026-07-20T00:00:00.000Z')))).toEqual({
      [INSIGHT_C]: C_TEXT,
      [INSIGHT_B]: B_TEXT_V1,
    });
  });

  it('SUPERSEDE applies atomically: at exactly its timestamp the set holds the replacement, never a hole', async () => {
    const set = await asOf(T5);
    expect(texts(set)).toEqual({ [INSIGHT_C]: C_TEXT, [INSIGHT_B]: B_TEXT_V1 });
    expect(set).toHaveLength(2);
  });

  it('insightsAsOf(now) equals the current active snapshot (D4 invariant, generalized)', async () => {
    // Hand-declared current snapshot: what insights(state='active') holds
    // after the full timeline — C (A's replacement) + B at its latest text.
    const snapshot: Record<string, string> = {
      [INSIGHT_B]: B_TEXT_V2,
      [INSIGHT_C]: C_TEXT,
    };
    expect(texts(await asOf(NOW))).toEqual(snapshot);
  });

  it('returns rows sorted by id and stamps lastChangeAt with the last touching op', async () => {
    const set = await asOf(NOW);
    expect(set.map((i) => i.id)).toEqual([INSIGHT_B, INSIGHT_C]);
    expect(set.find((i) => i.id === INSIGHT_B)?.lastChangeAt).toEqual(T6);
    expect(set.find((i) => i.id === INSIGHT_C)?.lastChangeAt).toEqual(T5);
  });

  it('passes the entity scope through to the loader', async () => {
    const load = vi.fn(fakeLoader([]));
    await insightsAsOf('account', CAMPAIGN_ID, NOW, { loadChanges: load });
    expect(load).toHaveBeenCalledWith({ entityType: 'account', entityId: CAMPAIGN_ID }, NOW);
  });

  it('rejects an invalid Date', async () => {
    await expect(asOf(new Date('nonsense'))).rejects.toThrow('invalid Date');
  });

  it('rejects a non-uuid entityId before any SQL runs', async () => {
    const load = vi.fn(fakeLoader(OP_LOG));
    await expect(
      insightsAsOf('campaign', 'drive-folder-ref-123', NOW, { loadChanges: load }),
    ).rejects.toThrow('not a uuid');
    expect(load).not.toHaveBeenCalled();
  });
});

describe('insightsAsOf — same-timestamp ties', () => {
  it('orders same-created_at rows by id (deterministic replay)', async () => {
    const ts = new Date('2026-06-20T00:00:00.000Z');
    // Same timestamp; the UPDATE's change id sorts after the ADD's, so the
    // fold must apply ADD first regardless of array order.
    const log = [
      row({
        changeId: 'aa000000-0000-7000-8000-000000000002',
        insightId: INSIGHT_A,
        op: 'UPDATE',
        newText: 'updated',
        createdAt: ts,
      }),
      row({
        changeId: 'aa000000-0000-7000-8000-000000000001',
        insightId: INSIGHT_A,
        op: 'ADD',
        newText: 'added',
        createdAt: ts,
      }),
    ];
    const warn = vi.fn();
    const set = await insightsAsOf('campaign', CAMPAIGN_ID, NOW, {
      loadChanges: fakeLoader(log),
      warn,
    });
    expect(texts(set)).toEqual({ [INSIGHT_A]: 'updated' });
    expect(warn).not.toHaveBeenCalled(); // ADD folded before UPDATE — no upsert warning
  });
});

describe('replayInsightChanges — fold degradation', () => {
  const at = new Date('2026-06-01T00:00:00.000Z');

  it('NOOP rows change nothing, whether present or absent', () => {
    const noop = row({
      changeId: 'dd000000-0000-7000-8000-0000000000dd',
      insightId: INSIGHT_A,
      op: 'NOOP',
      createdAt: at,
    });
    const base = [
      row({
        changeId: 'aa000000-0000-7000-8000-0000000000aa',
        insightId: INSIGHT_A,
        op: 'ADD',
        newText: 'fact',
        createdAt: at,
      }),
    ];
    expect(replayInsightChanges([...base, noop])).toEqual(replayInsightChanges(base));
  });

  it('warns on an unknown op and ignores it', () => {
    const warn = vi.fn();
    const set = replayInsightChanges(
      [
        row({
          changeId: 'ee000000-0000-7000-8000-0000000000ee',
          insightId: INSIGHT_A,
          op: 'MERGE',
          newText: 'x',
          createdAt: at,
        }),
      ],
      { warn },
    );
    expect(set).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown op "MERGE"'));
  });

  it('UPDATE on an insight missing from the active set warns and upserts', () => {
    const warn = vi.fn();
    const set = replayInsightChanges(
      [
        row({
          changeId: 'ee000000-0000-7000-8000-0000000000ee',
          insightId: INSIGHT_A,
          op: 'UPDATE',
          newText: 'orphan update',
          createdAt: at,
        }),
      ],
      { warn },
    );
    expect(texts(set)).toEqual({ [INSIGHT_A]: 'orphan update' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not in the replayed active set'));
  });

  it('ADD without new_text warns and materializes nothing', () => {
    const warn = vi.fn();
    const set = replayInsightChanges(
      [
        row({
          changeId: 'ee000000-0000-7000-8000-0000000000ee',
          insightId: INSIGHT_A,
          op: 'ADD',
          createdAt: at,
        }),
      ],
      { warn },
    );
    expect(set).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no new_text'));
  });

  it('re-ADD of an active insight warns and replaces the text', () => {
    const warn = vi.fn();
    const set = replayInsightChanges(
      [
        row({
          changeId: 'aa000000-0000-7000-8000-000000000001',
          insightId: INSIGHT_A,
          op: 'ADD',
          newText: 'first',
          createdAt: at,
        }),
        row({
          changeId: 'aa000000-0000-7000-8000-000000000002',
          insightId: INSIGHT_A,
          op: 'ADD',
          newText: 'second',
          createdAt: at,
        }),
      ],
      { warn },
    );
    expect(texts(set)).toEqual({ [INSIGHT_A]: 'second' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-adds active insight'));
  });

  it('SUPERSEDE with a missing replacement link warns and still drops the target', () => {
    const warn = vi.fn();
    const set = replayInsightChanges(
      [
        row({
          changeId: 'aa000000-0000-7000-8000-000000000001',
          insightId: INSIGHT_A,
          op: 'ADD',
          newText: 'fact',
          createdAt: at,
        }),
        row({
          changeId: 'aa000000-0000-7000-8000-000000000002',
          insightId: INSIGHT_A,
          op: 'SUPERSEDE',
          newText: 'replacement text',
          createdAt: at,
        }),
      ],
      { warn },
    );
    expect(set).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('created_by_op link missing'));
  });

  it('SUPERSEDE of an insight missing from the active set warns but still adds the replacement', () => {
    const warn = vi.fn();
    const set = replayInsightChanges(
      [
        row({
          changeId: 'aa000000-0000-7000-8000-000000000001',
          insightId: INSIGHT_A,
          op: 'SUPERSEDE',
          newText: 'replacement text',
          replacementId: INSIGHT_C,
          createdAt: at,
        }),
      ],
      { warn },
    );
    expect(texts(set)).toEqual({ [INSIGHT_C]: 'replacement text' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not in the replayed active set'));
  });

  it('is deterministic: replaying the same slice twice yields identical output', () => {
    const ordered = [...OP_LOG].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0),
    );
    expect(replayInsightChanges(ordered)).toEqual(replayInsightChanges(ordered));
  });
});
