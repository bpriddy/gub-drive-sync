/**
 * Hermetic suite for the D4 (#40) insight_op emit path (scan/propose.ts).
 *
 * The pure pieces (op hash, payload builder) are tested directly; the DB
 * writer runs against a hoisted fake prisma (module-boundary mock), so the
 * dedup guard and the fail-soft embedding path are exercised without a DB.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const F = vi.hoisted(() => {
  const state = {
    pendingMatch: null as null | { id: string },
    findFirstCalls: [] as unknown[],
    created: [] as Array<Record<string, unknown>>,
  };
  const prismaFake = {
    driveChangeProposal: {
      findFirst: async (args: unknown) => {
        state.findFirstCalls.push(args);
        return state.pendingMatch;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.created.push(data);
        return { id: `created-${state.created.length}`, ...data };
      },
    },
  };
  return { state, prismaFake };
});

vi.mock('../../prisma', () => ({ prisma: F.prismaFake }));
vi.mock('../../config', () => ({ config: { DRIVE_PROPOSAL_TTL_DAYS: 14 } }));
vi.mock('../output', () => ({ log: vi.fn() }));
vi.mock('../../ai', () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map((_, i) => [i + 0.5, i + 1.5])),
  // insight-reconcile (imported for InsightOpSchema) reads these at module
  // top level — stubs only, nothing here ever calls them.
  SchemaType: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER' },
  runPreset: vi.fn(),
  parseLlmJson: vi.fn(),
}));

import { Prisma } from '@prisma/client';
import { embedTexts } from '../../ai';
import { InsightOpSchema, type InsightOp } from '../../drive/insight-reconcile';
import {
  buildInsightOpProposal,
  insightOpFinalText,
  insightOpHash,
  proposeInsightOps,
} from '../propose';

const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const CAMPAIGN = 'bbbbbbbb-0000-4000-8000-000000000002';
const TARGET = 'cccccccc-0000-4000-8000-000000000003';

function makeOp(overrides: Partial<InsightOp> = {}): InsightOp {
  return InsightOpSchema.parse({
    op: 'ADD',
    candidate: {
      accountId: ACCOUNT,
      entityType: 'account',
      entityId: ACCOUNT,
      text: 'Acme prefers Q4 launches',
      sourceFileIds: ['file-1'],
      confidence: 0.9,
      origin: 'note',
    },
    reasoning: 'fresh fact',
    confidence: 0.9,
    retrieval: { k: 3, neighborIds: [], distances: [] },
    ...overrides,
  });
}

function makeUpdateOp(overrides: Partial<InsightOp> = {}): InsightOp {
  return makeOp({
    op: 'UPDATE',
    targetInsightId: TARGET,
    targetUpdatedAt: '2026-08-27T10:00:00.000Z',
    newText: 'Acme prefers Q4 launches (confirmed for 2026)',
    retrieval: { k: 3, neighborIds: [TARGET], distances: [0.12] },
    ...overrides,
  });
}

beforeEach(() => {
  F.state.pendingMatch = null;
  F.state.findFirstCalls = [];
  F.state.created = [];
  vi.mocked(embedTexts).mockClear();
});

// ── insightOpHash ────────────────────────────────────────────────────────────

describe('insightOpHash', () => {
  it('ignores volatile fields — same logical op hashes identically across scans', () => {
    const a = makeUpdateOp();
    const b = makeUpdateOp({
      confidence: 0.61,
      reasoning: 'totally different wording this run',
      targetUpdatedAt: '2026-08-28T09:00:00.000Z', // fresher CAS snapshot
      retrieval: { k: 3, neighborIds: [TARGET, ACCOUNT], distances: [0.2, 0.4] },
    });
    expect(insightOpHash(a)).toBe(insightOpHash(b));
  });

  it('changes when the semantic content changes', () => {
    const base = makeUpdateOp();
    expect(insightOpHash(makeUpdateOp({ newText: 'different merge' }))).not.toBe(
      insightOpHash(base),
    );
    expect(insightOpHash(makeOp())).not.toBe(insightOpHash(base)); // different verb
    const otherTarget = makeUpdateOp({
      targetInsightId: 'dddddddd-0000-4000-8000-000000000004',
      retrieval: { k: 3, neighborIds: ['dddddddd-0000-4000-8000-000000000004'], distances: [0.3] },
    });
    expect(insightOpHash(otherTarget)).not.toBe(insightOpHash(base));
  });
});

// ── final text ───────────────────────────────────────────────────────────────

describe('insightOpFinalText', () => {
  it('UPDATE uses newText (falling back to the candidate text)', () => {
    expect(insightOpFinalText(makeUpdateOp())).toBe(
      'Acme prefers Q4 launches (confirmed for 2026)',
    );
  });
  it('ADD/SUPERSEDE use the candidate text', () => {
    expect(insightOpFinalText(makeOp())).toBe('Acme prefers Q4 launches');
  });
});

// ── buildInsightOpProposal ───────────────────────────────────────────────────

describe('buildInsightOpProposal', () => {
  it('shapes an ADD account op', () => {
    const row = buildInsightOpProposal(makeOp(), [0.1, 0.2]);
    expect(row).toMatchObject({
      kind: 'insight_op',
      entityType: 'account',
      accountId: ACCOUNT,
      campaignId: null,
      property: '__insight_op__',
    });
    expect(row.proposedValue).toMatchObject({
      op: 'ADD',
      opHash: row.opHash,
      embedding: [0.1, 0.2],
    });
    expect(row.proposedValue).not.toHaveProperty('targetInsightId');
    expect(row.proposedValue).not.toHaveProperty('newText');
  });

  it('shapes an UPDATE against an existing campaign (campaignId set)', () => {
    const op = makeUpdateOp({
      candidate: {
        accountId: ACCOUNT,
        entityType: 'campaign',
        entityId: CAMPAIGN,
        entityStatus: 'existing',
        text: 'campaign shifted to October',
        sourceFileIds: ['file-2'],
        confidence: 0.8,
        origin: 'note',
      },
      newText: 'campaign shifted to October (was September)',
    });
    const row = buildInsightOpProposal(op, null);
    expect(row.entityType).toBe('campaign');
    expect(row.campaignId).toBe(CAMPAIGN);
    expect(row.accountId).toBe(ACCOUNT);
    expect(row.proposedValue).toMatchObject({
      targetInsightId: TARGET,
      targetUpdatedAt: '2026-08-27T10:00:00.000Z',
      newText: 'campaign shifted to October (was September)',
    });
    expect(row.proposedValue).not.toHaveProperty('embedding'); // null → omitted
  });

  it('anchors an unresolved new-campaign candidate on the account', () => {
    const op = makeOp({
      candidate: {
        accountId: ACCOUNT,
        entityType: 'campaign',
        entityId: 'drive-folder-ref-123', // folder ref, not a store uuid
        entityStatus: 'new',
        text: 'kickoff planned for September',
        sourceFileIds: ['file-3'],
        confidence: 0.7,
        origin: 'note',
      },
      unresolvedEntity: true,
    });
    const row = buildInsightOpProposal(op, null);
    expect(row.campaignId).toBeNull(); // no campaign row yet — CHECK-safe
    expect(row.accountId).toBe(ACCOUNT);
    expect(row.proposedValue).toMatchObject({ unresolvedEntity: true });
    expect((row.proposedValue.candidate as { entityId: string }).entityId).toBe(
      'drive-folder-ref-123',
    );
  });
});

// ── proposeInsightOps (DB writer against the fake) ───────────────────────────

describe('proposeInsightOps', () => {
  const reviewer = { reviewerEmail: 'owner@example.test', reviewerStaffId: 'staff-1' };
  const SYNC_RUN = 'eeeeeeee-0000-4000-8000-000000000005';

  it('NOOP ops never become cards', async () => {
    const noop = makeOp({
      op: 'NOOP',
      targetInsightId: TARGET,
      targetUpdatedAt: '2026-08-27T10:00:00.000Z',
      retrieval: { k: 3, neighborIds: [TARGET], distances: [0.05] },
    });
    const res = await proposeInsightOps({ ops: [noop], reviewer, syncRunId: SYNC_RUN });
    expect(res).toEqual({ emitted: 0, duplicatesSkipped: 0, noops: 1 });
    expect(F.state.created).toHaveLength(0);
    expect(embedTexts).not.toHaveBeenCalled(); // nothing to embed
  });

  it('emits a proposal row with run provenance, reviewer, TTL and one batch embed call', async () => {
    const ops = [makeOp(), makeUpdateOp()];
    const before = Date.now();
    const res = await proposeInsightOps({ ops, reviewer, syncRunId: SYNC_RUN });

    expect(res).toEqual({ emitted: 2, duplicatesSkipped: 0, noops: 0 });
    expect(embedTexts).toHaveBeenCalledTimes(1); // one call for the batch
    expect(vi.mocked(embedTexts).mock.calls[0]![0]).toEqual([
      'Acme prefers Q4 launches',
      'Acme prefers Q4 launches (confirmed for 2026)',
    ]);

    const row = F.state.created[0]!;
    expect(row).toMatchObject({
      kind: 'insight_op',
      state: 'pending',
      syncRunId: SYNC_RUN, // attached at emit — not on the op (D3 contract)
      reviewerEmail: 'owner@example.test',
      reviewerStaffId: 'staff-1',
    });
    expect((row.confidence as Prisma.Decimal).toNumber()).toBeCloseTo(0.9);
    expect(row.reviewToken).toMatch(/^[0-9a-f]{64}$/);
    const expires = (row.expiresAt as Date).getTime();
    expect(expires).toBeGreaterThan(before + 13 * 86_400_000);
    expect(expires).toBeLessThan(before + 15 * 86_400_000);
    // Each op got ITS vector, not the batch's first.
    expect((row.proposedValue as { embedding: number[] }).embedding).toEqual([0.5, 1.5]);
    expect(
      (F.state.created[1]!.proposedValue as { embedding: number[] }).embedding,
    ).toEqual([1.5, 2.5]);
  });

  it('skips an op with an identical pending card, keyed on (entity, op-hash)', async () => {
    F.state.pendingMatch = { id: 'already-pending' };
    const op = makeOp();
    const res = await proposeInsightOps({ ops: [op], reviewer, syncRunId: SYNC_RUN });

    expect(res).toEqual({ emitted: 0, duplicatesSkipped: 1, noops: 0 });
    expect(F.state.created).toHaveLength(0);
    const where = (F.state.findFirstCalls[0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      kind: 'insight_op',
      entityType: 'account',
      accountId: ACCOUNT,
      campaignId: null,
      state: 'pending',
      proposedValue: { path: ['opHash'], equals: insightOpHash(op) },
    });
  });

  it('fail-soft: an embedding outage still emits cards, just without vectors', async () => {
    const res = await proposeInsightOps({
      ops: [makeOp()],
      reviewer,
      syncRunId: SYNC_RUN,
      embed: async () => {
        throw new Error('embedding quota exhausted');
      },
    });
    expect(res.emitted).toBe(1);
    expect(F.state.created[0]!.proposedValue).not.toHaveProperty('embedding');
  });
});
