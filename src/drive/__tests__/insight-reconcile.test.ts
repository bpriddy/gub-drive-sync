/**
 * Hermetic suite for insight-reconcile.ts (D3 #39).
 *
 * Everything external is injected through ReconcileOptions (embed,
 * retrieve, runPresetFn) — no prisma, no Gemini. The module boundary
 * mocks below only neutralize import-time side effects (config env
 * validation, prisma client construction).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../prisma', () => ({ prisma: {} }));

import type { runPreset } from '../../ai';
import type { CandidateInsight } from '../candidate-insight';
import {
  InsightOpSchema,
  RECONCILE_CONFIDENCE_FLOOR,
  reconcileCandidate,
  reconcileCandidates,
  type InsightNeighbor,
} from '../insight-reconcile';

const ACCOUNT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CAMPAIGN_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const NEIGHBOR_1 = '11111111-1111-4111-8111-111111111111';
const NEIGHBOR_2 = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

const NEIGHBOR_1_UPDATED_AT = new Date('2026-08-01T12:00:00.000Z');

function candidate(over: Partial<CandidateInsight> = {}): CandidateInsight {
  return {
    accountId: ACCOUNT_ID,
    entityType: 'campaign',
    entityId: CAMPAIGN_ID,
    entityStatus: 'existing',
    text: 'Launch date shifted from May to June 1.',
    sourceFileIds: ['file_a'],
    confidence: 0.8,
    origin: 'note',
    ...over,
  };
}

function neighbor(id: string, over: Partial<InsightNeighbor> = {}): InsightNeighbor {
  return {
    id,
    text: 'Launch is planned for May.',
    state: 'active',
    updatedAt: NEIGHBOR_1_UPDATED_AT,
    distance: 0.12,
    ...over,
  };
}

type LlmResponse = {
  op: string;
  target_id?: string | null;
  new_text?: string | null;
  reasoning?: string;
  confidence?: number;
};

function presetReturning(response: LlmResponse): typeof runPreset {
  return vi.fn(async () => ({
    text: JSON.stringify({ reasoning: 'because', confidence: 0.9, ...response }),
    driver: 'test',
    model: 'test-model',
    prompt: 'rendered',
  })) as unknown as typeof runPreset;
}

const NEIGHBORS = [neighbor(NEIGHBOR_1), neighbor(NEIGHBOR_2, { distance: 0.4 })];

describe('reconcileCandidate — verb mapping', () => {
  it('maps ADD with no target and full retrieval telemetry', async () => {
    const op = await reconcileCandidate(candidate(), NEIGHBORS, {
      runPresetFn: presetReturning({ op: 'ADD' }),
    });
    expect(op.op).toBe('ADD');
    expect(op.targetInsightId).toBeUndefined();
    expect(op.targetUpdatedAt).toBeUndefined();
    expect(op.retrieval.neighborIds).toEqual([NEIGHBOR_1, NEIGHBOR_2]);
    expect(op.retrieval.distances).toEqual([0.12, 0.4]);
  });

  it('maps UPDATE with target, stale snapshot, and merged text', async () => {
    const op = await reconcileCandidate(candidate(), NEIGHBORS, {
      runPresetFn: presetReturning({ op: 'UPDATE', target_id: NEIGHBOR_1, new_text: 'merged text' }),
    });
    expect(op.op).toBe('UPDATE');
    expect(op.targetInsightId).toBe(NEIGHBOR_1);
    expect(op.targetUpdatedAt).toBe(NEIGHBOR_1_UPDATED_AT.toISOString());
    expect(op.newText).toBe('merged text');
  });

  it('falls back to the candidate text when UPDATE omits new_text', async () => {
    const op = await reconcileCandidate(candidate(), NEIGHBORS, {
      runPresetFn: presetReturning({ op: 'UPDATE', target_id: NEIGHBOR_1, new_text: null }),
    });
    expect(op.newText).toBe(candidate().text);
  });

  it('maps SUPERSEDE with target and no newText', async () => {
    const op = await reconcileCandidate(candidate(), NEIGHBORS, {
      runPresetFn: presetReturning({ op: 'SUPERSEDE', target_id: NEIGHBOR_2 }),
    });
    expect(op.op).toBe('SUPERSEDE');
    expect(op.targetInsightId).toBe(NEIGHBOR_2);
    expect(op.newText).toBeUndefined();
  });

  it('maps NOOP with target', async () => {
    const op = await reconcileCandidate(candidate(), NEIGHBORS, {
      runPresetFn: presetReturning({ op: 'NOOP', target_id: NEIGHBOR_1 }),
    });
    expect(op.op).toBe('NOOP');
    expect(op.targetInsightId).toBe(NEIGHBOR_1);
  });

  it('passes entity_type, candidate_text, and neighbors to the preset', async () => {
    const runPresetFn = presetReturning({ op: 'ADD' });
    await reconcileCandidate(candidate(), NEIGHBORS, { runPresetFn });
    const call = (runPresetFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.key).toBe('drive.insight_reconcile.v1');
    expect(call.variables.entity_type).toBe('campaign');
    expect(call.variables.candidate_text).toBe(candidate().text);
    expect(call.variables.neighbors_json).toContain(NEIGHBOR_1);
    expect(call.variables.neighbors_json).toContain('Launch is planned for May.');
  });

  it('rejects a malformed LLM op value', async () => {
    await expect(
      reconcileCandidate(candidate(), NEIGHBORS, {
        runPresetFn: presetReturning({ op: 'MERGE', target_id: NEIGHBOR_1 }),
      }),
    ).rejects.toThrow();
  });
});

describe('reconcileCandidate — guards', () => {
  it('demotes a merge verb below the confidence floor to ADD', async () => {
    const warn = vi.fn();
    const op = await reconcileCandidate(candidate(), NEIGHBORS, {
      runPresetFn: presetReturning({
        op: 'NOOP',
        target_id: NEIGHBOR_1,
        confidence: RECONCILE_CONFIDENCE_FLOOR - 0.1,
      }),
      warn,
    });
    expect(op.op).toBe('ADD');
    expect(op.demotedFrom).toBe('NOOP');
    expect(op.targetInsightId).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('below floor'));
  });

  it('keeps a merge verb at exactly the floor', async () => {
    const op = await reconcileCandidate(candidate(), NEIGHBORS, {
      runPresetFn: presetReturning({
        op: 'NOOP',
        target_id: NEIGHBOR_1,
        confidence: RECONCILE_CONFIDENCE_FLOOR,
      }),
    });
    expect(op.op).toBe('NOOP');
  });

  it('demotes a hallucinated target (id not among retrieved neighbors) to ADD', async () => {
    const warn = vi.fn();
    const op = await reconcileCandidate(candidate(), NEIGHBORS, {
      runPresetFn: presetReturning({ op: 'UPDATE', target_id: UNKNOWN_ID, new_text: 'x' }),
      warn,
    });
    expect(op.op).toBe('ADD');
    expect(op.demotedFrom).toBe('UPDATE');
    expect(op.targetInsightId).toBeUndefined();
    expect(op.newText).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not among retrieved neighbors'));
  });

  it('demotes a merge verb with a missing target_id to ADD', async () => {
    const op = await reconcileCandidate(candidate(), NEIGHBORS, {
      runPresetFn: presetReturning({ op: 'SUPERSEDE', target_id: null }),
    });
    expect(op.op).toBe('ADD');
    expect(op.demotedFrom).toBe('SUPERSEDE');
  });
});

describe('reconcileCandidates — orchestration', () => {
  it("bypasses retrieval for 'new'-campaign candidates (folder-ref entityId)", async () => {
    const embed = vi.fn();
    const retrieve = vi.fn();
    const runPresetFn = presetReturning({ op: 'ADD' });
    const [op] = await reconcileCandidates(
      [candidate({ entityStatus: 'new', entityId: 'folder_abc123' })],
      { embed, retrieve, runPresetFn },
    );
    expect(op!.op).toBe('ADD');
    expect(op!.unresolvedEntity).toBe(true);
    expect(op!.retrieval).toEqual({ k: 3, neighborIds: [], distances: [] });
    expect(embed).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(runPresetFn).not.toHaveBeenCalled();
  });

  it('emits ADD without an LLM call on an empty container', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    const retrieve = vi.fn(async () => []);
    const runPresetFn = presetReturning({ op: 'NOOP', target_id: NEIGHBOR_1 });
    const [op] = await reconcileCandidates([candidate()], { embed, retrieve, runPresetFn });
    expect(op!.op).toBe('ADD');
    expect(op!.reasoning).toContain('empty container');
    expect(op!.unresolvedEntity).toBeUndefined();
    expect(runPresetFn).not.toHaveBeenCalled();
  });

  it('warns and emits unresolved ADD for a non-uuid entityId on an existing entity', async () => {
    const warn = vi.fn();
    const embed = vi.fn();
    const [op] = await reconcileCandidates([candidate({ entityId: 'not-a-uuid' })], {
      embed,
      warn,
    });
    expect(op!.op).toBe('ADD');
    expect(op!.unresolvedEntity).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('non-uuid entityId'));
  });

  it('embeds all retrievable candidates in one batch and preserves input order', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map((_, i) => [i, 0, 0]));
    const seen: Array<{ entityId: string; vec: number[] }> = [];
    const retrieve = vi.fn(
      async (scope: { entityType: string; entityId: string }, vec: number[]) => {
        seen.push({ entityId: scope.entityId, vec });
        return [neighbor(NEIGHBOR_1)];
      },
    );
    const runPresetFn = presetReturning({ op: 'NOOP', target_id: NEIGHBOR_1 });
    const ops = await reconcileCandidates(
      [
        candidate({ text: 'first', entityType: 'account', entityId: ACCOUNT_ID }),
        candidate({ entityStatus: 'new', entityId: 'folder_x', text: 'second' }),
        candidate({ text: 'third' }),
      ],
      { embed, retrieve, runPresetFn },
    );
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(['first', 'third']);
    expect(seen).toEqual([
      { entityId: ACCOUNT_ID, vec: [0, 0, 0] },
      { entityId: CAMPAIGN_ID, vec: [1, 0, 0] },
    ]);
    expect(ops.map((o) => o.candidate.text)).toEqual(['first', 'second', 'third']);
    expect(ops[1]!.unresolvedEntity).toBe(true);
    expect(ops[0]!.op).toBe('NOOP');
    expect(ops[2]!.op).toBe('NOOP');
  });

  it('passes the configured k through to retrieval and telemetry', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1]));
    const retrieve = vi.fn(async () => [neighbor(NEIGHBOR_1)]);
    const runPresetFn = presetReturning({ op: 'NOOP', target_id: NEIGHBOR_1 });
    const [op] = await reconcileCandidates([candidate()], {
      k: 5,
      embed,
      retrieve,
      runPresetFn,
    });
    expect(retrieve).toHaveBeenCalledWith(expect.anything(), [1], 5);
    expect(op!.retrieval.k).toBe(5);
  });
});

describe('InsightOpSchema — zod rejections', () => {
  const base = {
    candidate: candidate(),
    reasoning: 'because',
    confidence: 0.9,
    retrieval: { k: 3, neighborIds: [NEIGHBOR_1], distances: [0.1] },
  };

  it('rejects UPDATE without a target', () => {
    const res = InsightOpSchema.safeParse({ ...base, op: 'UPDATE', newText: 'x' });
    expect(res.success).toBe(false);
  });

  it('rejects a merge verb without targetUpdatedAt', () => {
    const res = InsightOpSchema.safeParse({
      ...base,
      op: 'NOOP',
      targetInsightId: NEIGHBOR_1,
    });
    expect(res.success).toBe(false);
  });

  it('rejects ADD carrying a target', () => {
    const res = InsightOpSchema.safeParse({
      ...base,
      op: 'ADD',
      targetInsightId: NEIGHBOR_1,
      targetUpdatedAt: NEIGHBOR_1_UPDATED_AT.toISOString(),
    });
    expect(res.success).toBe(false);
  });

  it('rejects confidence out of range', () => {
    const res = InsightOpSchema.safeParse({ ...base, op: 'ADD', confidence: 1.5 });
    expect(res.success).toBe(false);
  });

  it('rejects a non-uuid targetInsightId', () => {
    const res = InsightOpSchema.safeParse({
      ...base,
      op: 'NOOP',
      targetInsightId: 'nope',
      targetUpdatedAt: NEIGHBOR_1_UPDATED_AT.toISOString(),
    });
    expect(res.success).toBe(false);
  });

  it('accepts a fully-formed UPDATE', () => {
    const res = InsightOpSchema.safeParse({
      ...base,
      op: 'UPDATE',
      targetInsightId: NEIGHBOR_1,
      targetUpdatedAt: NEIGHBOR_1_UPDATED_AT.toISOString(),
      newText: 'merged',
    });
    expect(res.success).toBe(true);
  });
});
