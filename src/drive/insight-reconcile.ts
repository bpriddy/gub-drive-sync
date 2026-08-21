/**
 * insight-reconcile.ts — D3 (#39): scoped retrieval + reconciliation op.
 *
 * Takes D2's in-memory CandidateInsight[], embeds each candidate, retrieves
 * its top-K ACTIVE stored insights within (entity_type, entity_id) via raw
 * pgvector `<=>`, runs the drive.insight_reconcile.v1 preset, and emits
 * zod-validated InsightOp[] — ADD | UPDATE(target) | SUPERSEDE(target) |
 * NOOP(target). Op PRODUCER only: no writes to insights/insight_changes
 * (that's D4), no idempotency keys, no review gate (B1/D4).
 *
 * Store access is prisma.$queryRaw on purpose: drive-sync's prisma schema
 * has no Insight models (schema-package adoption is PR #4, out of scope),
 * and the `embedding` column is Unsupported("vector") anyway. The table
 * shape is frozen in gub-schemas feat/schema-v0.3.0-insights; dev DBs get
 * the spec's Appendix A DDL until the canonical D1 (#37) migration lands.
 *
 * Kept out of structured-output.ts (existing prompts' schemas) and
 * schema.ts (GUB-lockstep) per the D2 precedent — the Gemini response
 * schema and the op contract live here, with their consumer.
 */

import { z } from 'zod';
import { prisma } from '../prisma';
import { logger } from '../logger';
import {
  embedTexts,
  parseLlmJson,
  runPreset,
  SchemaType,
  type Schema,
} from '../ai';
import { CandidateInsightSchema, type CandidateInsight } from './candidate-insight';

export const RECONCILE_PRESET_KEY = 'drive.insight_reconcile.v1';

/** Top-K neighbors per candidate. Brute-force `<=>` per B4 — container
 * sizes are tens–hundreds; no vector index tuning in D3. */
export const DEFAULT_RETRIEVAL_K = 3;

/**
 * Confidence floor (pending ratification): a merge verb the reconciler
 * itself isn't sure about demotes to ADD — a duplicate is recoverable,
 * a wrong merge is not.
 */
export const RECONCILE_CONFIDENCE_FLOOR = 0.6;

const MERGE_OPS = ['UPDATE', 'SUPERSEDE', 'NOOP'] as const;

/**
 * The D3→D4 op contract. `targetInsightId` + `targetUpdatedAt` are the
 * stale-race snapshot: D4's transactional apply re-reads the target and
 * bails when updated_at moved. `retrieval` is telemetry for D4 debugging
 * and the eval — never prompt input.
 */
export const InsightOpSchema = z
  .object({
    op: z.enum(['ADD', 'UPDATE', 'SUPERSEDE', 'NOOP']),
    candidate: CandidateInsightSchema,
    targetInsightId: z.string().uuid().optional(),
    targetUpdatedAt: z.string().datetime({ offset: true }).optional(),
    /** UPDATE only: merged/refreshed insight text. */
    newText: z.string().min(1).optional(),
    reasoning: z.string(),
    confidence: z.number().min(0).max(1),
    /** 'new'-campaign candidates: entityId is a folder ref, not a store uuid. */
    unresolvedEntity: z.literal(true).optional(),
    /** Set when a guard downgraded a merge verb (floor / hallucinated target). */
    demotedFrom: z.enum(MERGE_OPS).optional(),
    retrieval: z.object({
      k: z.number().int().nonnegative(),
      neighborIds: z.array(z.string().uuid()),
      distances: z.array(z.number()),
    }),
  })
  .superRefine((op, ctx) => {
    if (op.op === 'ADD') {
      if (op.targetInsightId !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ADD must not carry a target' });
      }
      return;
    }
    if (op.targetInsightId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${op.op} requires targetInsightId` });
    }
    if (op.targetUpdatedAt === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${op.op} requires targetUpdatedAt` });
    }
  });

export type InsightOp = z.infer<typeof InsightOpSchema>;

// ── LLM response contract (this prompt's schema lives HERE, not in
// structured-output.ts — D2 precedent) ───────────────────────────────────────

const reconcileResponseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    op: {
      type: SchemaType.STRING,
      enum: ['ADD', 'UPDATE', 'SUPERSEDE', 'NOOP'],
      description: 'The single reconciliation operation for the candidate.',
    },
    target_id: {
      type: SchemaType.STRING,
      nullable: true,
      description:
        'For UPDATE/SUPERSEDE/NOOP: the id of the neighbor insight this operation targets. MUST be one of the neighbor ids shown in the prompt. NULL for ADD.',
    },
    new_text: {
      type: SchemaType.STRING,
      nullable: true,
      description:
        'For UPDATE: the merged/refreshed insight text (no facts lost). NULL otherwise.',
    },
    reasoning: {
      type: SchemaType.STRING,
      description: 'One or two sentences justifying the operation.',
    },
    confidence: {
      type: SchemaType.NUMBER,
      description: '0.0–1.0 — confidence in the chosen operation.',
    },
  },
  required: ['op', 'reasoning', 'confidence'],
};

const ReconcileLlmResponseSchema = z.object({
  op: z.enum(['ADD', 'UPDATE', 'SUPERSEDE', 'NOOP']),
  target_id: z.string().nullish(),
  new_text: z.string().nullish(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

// ── Retrieval ────────────────────────────────────────────────────────────────

export interface RetrievalScope {
  entityType: 'account' | 'campaign';
  entityId: string;
}

export interface InsightNeighbor {
  id: string;
  text: string;
  state: string;
  updatedAt: Date;
  /** Cosine distance (`<=>`) from the candidate embedding. */
  distance: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Top-K ACTIVE insights in the candidate's container by cosine distance.
 * Raw SQL (see module header); explicit `::vector` / `::uuid` casts, the
 * vector passed as a `[x,y,…]` string literal.
 */
export async function retrieveNeighbors(
  scope: RetrievalScope,
  queryVec: number[],
  k: number = DEFAULT_RETRIEVAL_K,
): Promise<InsightNeighbor[]> {
  const vec = `[${queryVec.join(',')}]`;
  const rows = await prisma.$queryRaw<
    Array<{ id: string; text: string; state: string; updated_at: Date; distance: number }>
  >`
    SELECT id::text AS id, text, state, updated_at,
           embedding <=> ${vec}::vector AS distance
    FROM insights
    WHERE entity_type = ${scope.entityType}
      AND entity_id = ${scope.entityId}::uuid
      AND state = 'active'
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${k}
  `;
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    state: r.state,
    updatedAt: r.updated_at,
    distance: r.distance,
  }));
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/** Injectable seams so the hermetic suite never touches prisma/Gemini. */
export interface ReconcileOptions {
  k?: number;
  confidenceFloor?: number;
  embed?: (texts: string[]) => Promise<number[][]>;
  retrieve?: typeof retrieveNeighbors;
  runPresetFn?: typeof runPreset;
  warn?: (message: string) => void;
}

function baseRetrieval(k: number, neighbors: InsightNeighbor[]): InsightOp['retrieval'] {
  return {
    k,
    neighborIds: neighbors.map((n) => n.id),
    distances: neighbors.map((n) => n.distance),
  };
}

function addOp(
  candidate: CandidateInsight,
  reasoning: string,
  confidence: number,
  retrieval: InsightOp['retrieval'],
  extras: Partial<Pick<InsightOp, 'unresolvedEntity' | 'demotedFrom'>> = {},
): InsightOp {
  return InsightOpSchema.parse({
    op: 'ADD',
    candidate,
    reasoning,
    confidence,
    retrieval,
    ...extras,
  });
}

/**
 * One candidate vs its retrieved neighbors → one validated op.
 * Caller guarantees `neighbors` is non-empty (the empty-container ADD
 * short-circuit lives in reconcileCandidates).
 */
export async function reconcileCandidate(
  candidate: CandidateInsight,
  neighbors: InsightNeighbor[],
  opts: ReconcileOptions = {},
): Promise<InsightOp> {
  const runPresetFn = opts.runPresetFn ?? runPreset;
  const floor = opts.confidenceFloor ?? RECONCILE_CONFIDENCE_FLOOR;
  const warn = opts.warn ?? ((m: string): void => logger.warn(`[insight-reconcile] ${m}`));
  const retrieval = baseRetrieval(opts.k ?? neighbors.length, neighbors);

  const completion = await runPresetFn({
    key: RECONCILE_PRESET_KEY,
    responseSchema: reconcileResponseSchema,
    variables: {
      entity_type: candidate.entityType,
      candidate_text: candidate.text,
      neighbors_json: JSON.stringify(
        neighbors.map((n) => ({ id: n.id, text: n.text })),
        null,
        2,
      ),
    },
  });

  const response = ReconcileLlmResponseSchema.parse(parseLlmJson(completion.text));

  if (response.op === 'ADD') {
    return addOp(candidate, response.reasoning, response.confidence, retrieval);
  }

  // Hallucinated-target guard: an op referencing an id the LLM wasn't
  // shown is invalid — a duplicate ADD is the safe degrade.
  const target = response.target_id
    ? neighbors.find((n) => n.id === response.target_id)
    : undefined;
  if (!target) {
    warn(
      `${response.op} target ${response.target_id ?? '(none)'} not among retrieved neighbors — demoting to ADD ("${candidate.text.slice(0, 60)}")`,
    );
    return addOp(candidate, response.reasoning, response.confidence, retrieval, {
      demotedFrom: response.op,
    });
  }

  // Confidence floor: below it, a merge verb demotes to ADD.
  if (response.confidence < floor) {
    warn(
      `${response.op} confidence ${response.confidence.toFixed(2)} below floor ${floor} — demoting to ADD ("${candidate.text.slice(0, 60)}")`,
    );
    return addOp(candidate, response.reasoning, response.confidence, retrieval, {
      demotedFrom: response.op,
    });
  }

  return InsightOpSchema.parse({
    op: response.op,
    candidate,
    targetInsightId: target.id,
    targetUpdatedAt: target.updatedAt.toISOString(),
    // UPDATE without new_text: fall back to the candidate text — the
    // refresh IS the candidate. SUPERSEDE/NOOP carry no newText.
    ...(response.op === 'UPDATE' ? { newText: response.new_text ?? candidate.text } : {}),
    reasoning: response.reasoning,
    confidence: response.confidence,
    retrieval,
  });
}

/**
 * Orchestrate a scan's candidates into ops:
 *   - entityStatus 'new' (folder-ref entityId, no uuid container yet) →
 *     ADD + unresolvedEntity, no retrieval, no LLM. D4 resolves
 *     folder→campaign uuid at apply.
 *   - empty container → ADD without an LLM call.
 *   - otherwise embed → retrieve → reconcile.
 *
 * Errors propagate — the flag-gated dryrun caller fails soft (a missing
 * preset must not kill the scan print), the eval wants the throw.
 */
export async function reconcileCandidates(
  candidates: CandidateInsight[],
  opts: ReconcileOptions = {},
): Promise<InsightOp[]> {
  const k = opts.k ?? DEFAULT_RETRIEVAL_K;
  const embed = opts.embed ?? embedTexts;
  const retrieve = opts.retrieve ?? retrieveNeighbors;
  const warn = opts.warn ?? ((m: string): void => logger.warn(`[insight-reconcile] ${m}`));
  const emptyRetrieval = { k, neighborIds: [], distances: [] };

  const ops = new Array<InsightOp>(candidates.length);
  const retrievable: Array<{ index: number; candidate: CandidateInsight }> = [];

  for (const [index, candidate] of candidates.entries()) {
    if (candidate.entityStatus === 'new') {
      ops[index] = addOp(
        candidate,
        'new-entity candidate — no store container exists yet; reconciliation bypassed',
        candidate.confidence,
        emptyRetrieval,
        { unresolvedEntity: true },
      );
      continue;
    }
    if (!UUID_RE.test(candidate.entityId)) {
      // Defensive: only 'new' candidates should carry non-uuid entityIds,
      // but a raw `::uuid` cast on a bad id would kill the whole batch.
      warn(
        `non-uuid entityId "${candidate.entityId}" on ${candidate.entityStatus ?? 'existing'} ${candidate.entityType} — treating as unresolved, emitting ADD`,
      );
      ops[index] = addOp(
        candidate,
        'entityId is not a store uuid — reconciliation bypassed',
        candidate.confidence,
        emptyRetrieval,
        { unresolvedEntity: true },
      );
      continue;
    }
    retrievable.push({ index, candidate });
  }

  if (retrievable.length === 0) return ops;

  // One embed call for the whole scan — the batch is the unit the API bills.
  const vectors = await embed(retrievable.map((r) => r.candidate.text));

  for (const [i, { index, candidate }] of retrievable.entries()) {
    const neighbors = await retrieve(
      { entityType: candidate.entityType, entityId: candidate.entityId },
      vectors[i]!,
      k,
    );
    ops[index] =
      neighbors.length === 0
        ? addOp(
            candidate,
            'empty container — no active insights to reconcile against',
            candidate.confidence,
            emptyRetrieval,
          )
        : await reconcileCandidate(candidate, neighbors, { ...opts, k });
  }

  return ops;
}
