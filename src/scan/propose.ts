// Part of the scan core (src/scan/) — mode-agnostic batch machinery shared
// by every driver (day-walk backfill today; the Activity forward driver next).
//
// ── The PROPOSE application path ─────────────────────────────────────────────
//
// Forward sync PROPOSES; review APPLIES (docs/forward-sync-v2-design.md,
// "Application policy"; status-markdown-plan.md D6/D7/D14). This module
// writes the same drive_change_proposals row shapes the v1 distillAndEmit
// writer produces, so the existing reviewer stack — notify fan-out,
// gub-review magic-link UI, GUB applyDecisions + synthesis — consumes
// scan-core output with zero changes on its side:
//
//   - kind='field_change'      one row per validated field change
//   - kind='additional_update' ONE batched row per entity per scan,
//                              property='__note__', proposedValue={items}
//
// New-campaign candidates have no DB row (the proposal CHECK forbids a
// campaign proposal without a campaign id), so their signal lands as a
// clearly-prefixed items batch on the ACCOUNT card. TODO(v2-phase-1.x):
// route these through discover.ts's new_entity proposal-group flow once
// proposeNewEntity is exported.

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { config } from '../config';
import { log } from './output';
import type { ValidatedChange } from './persist';
import type { EntityCtx } from './batch-types';
import { newCandidateMarker } from './note-marker';
import { embedTexts } from '../ai';
import type { InsightOp } from '../drive/insight-reconcile';

export interface ProposeNoteItem {
  text: string;
  source_file_ids: string[];
}

export interface ProposeTargetInput {
  ctx: EntityCtx;
  entityType: 'account' | 'campaign';
  /** 'account' | 'existing' | 'new' — new candidates take the account-card fallback. */
  entityStatus: 'account' | 'existing' | 'new';
  /** DB row id; null only for new candidates. */
  entityId: string | null;
  entityName: string;
  validatedChanges: ValidatedChange[];
  notes: ProposeNoteItem[];
}

export interface ProposeTargetResult {
  fieldProposals: number;
  noteItems: number;
  /** field_change rows skipped because an identical pending proposal exists. */
  duplicatesSkipped: number;
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);
}

export async function proposeTarget(input: ProposeTargetInput): Promise<ProposeTargetResult> {
  const { ctx, validatedChanges, notes } = input;
  const expiresAt = new Date(
    Date.now() + config.DRIVE_PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  const reviewer = {
    reviewerEmail: ctx.reviewerEmail ?? null,
    reviewerStaffId: ctx.reviewerStaffId ?? null,
  };

  // ── New-candidate fallback: everything goes to the account card ──────────
  if (input.entityStatus === 'new' || (input.entityType === 'campaign' && !input.entityId)) {
    const items: ProposeNoteItem[] = [
      ...validatedChanges.map((vc) => ({
        text: `${newCandidateMarker(input.entityName)} ${vc.field}: ${vc.proposedValueRaw ?? '(null)'}`,
        source_file_ids: vc.sourceFileIds,
      })),
      ...notes.map((n) => ({
        text: `${newCandidateMarker(input.entityName)} ${n.text}`,
        source_file_ids: n.source_file_ids,
      })),
    ];
    if (items.length === 0) return { fieldProposals: 0, noteItems: 0, duplicatesSkipped: 0 };
    await writeNoteBatch({
      entityType: 'account',
      accountId: ctx.accountId,
      campaignId: null,
      items,
      reviewer,
      expiresAt,
    });
    return { fieldProposals: 0, noteItems: items.length, duplicatesSkipped: 0 };
  }

  const accountId = input.entityType === 'account' ? input.entityId : ctx.accountId;
  const campaignId = input.entityType === 'campaign' ? input.entityId : null;

  // ── field_change rows ────────────────────────────────────────────────────
  let fieldProposals = 0;
  let duplicatesSkipped = 0;
  for (const vc of validatedChanges) {
    // Re-propose guard: an identical pending proposal (same property, same
    // proposed value) means the reviewer already has this card — writing
    // another would stack duplicates on every scan until they decide.
    // A pending proposal with a DIFFERENT value still gets a new row (the
    // newer evidence deserves its own card; sweep-expired trims stale ones).
    const proposedJson = toJson(vc.validatedValue);
    const pending = await prisma.driveChangeProposal.findFirst({
      where: {
        kind: 'field_change',
        entityType: input.entityType,
        accountId,
        campaignId,
        property: vc.field,
        state: 'pending',
      },
      select: { id: true, proposedValue: true },
    });
    if (
      pending &&
      JSON.stringify(pending.proposedValue ?? null) ===
        JSON.stringify(vc.validatedValue ?? null)
    ) {
      duplicatesSkipped++;
      continue;
    }
    await prisma.driveChangeProposal.create({
      data: {
        kind: 'field_change',
        entityType: input.entityType,
        accountId,
        campaignId,
        property: vc.field,
        currentValue: toJson(vc.previousValue),
        proposedValue: proposedJson,
        // Provenance the reviewer decides on: WHY this value, and which
        // files it came from. distillAndEmit (v1) has always carried both;
        // the scan-core propose path was writing null/[] and handing the
        // reviewer a bare value with no way to check it.
        reasoning: vc.reasoning,
        sourceFileIds: vc.sourceFileIds,
        confidence: new Prisma.Decimal(vc.confidence),
        state: 'pending',
        reviewToken: crypto.randomBytes(32).toString('hex'),
        ...reviewer,
        expiresAt,
      },
    });
    fieldProposals++;
  }

  // ── additional_update batch (notes) ──────────────────────────────────────
  let noteItems = 0;
  if (notes.length > 0) {
    await writeNoteBatch({
      entityType: input.entityType,
      accountId,
      campaignId,
      items: notes,
      reviewer,
      expiresAt,
    });
    noteItems = notes.length;
  }

  log(
    `      → proposed for review: ${fieldProposals} field change(s)${duplicatesSkipped > 0 ? ` (${duplicatesSkipped} already pending)` : ''}, ${noteItems} note item(s)`,
  );
  return { fieldProposals, noteItems, duplicatesSkipped };
}

/**
 * Note items already sitting in a PENDING proposal for this target.
 *
 * Half of the "already on record" set distillation dedupes against (the
 * other half is the entity's stored status bullets). A fact that's been
 * proposed but not yet decided isn't in the status doc yet, so the doc
 * alone wouldn't stop the next scan from proposing it again — which is
 * exactly the duplicate-card stacking review finding #2 reported.
 *
 * Returns raw item texts; the prompt does the semantic comparison.
 */
export async function loadPendingNoteTexts(args: {
  entityType: 'account' | 'campaign';
  accountId: string | null;
  campaignId: string | null;
}): Promise<string[]> {
  const rows = await prisma.driveChangeProposal.findMany({
    where: {
      kind: 'additional_update',
      property: '__note__',
      entityType: args.entityType,
      accountId: args.accountId,
      campaignId: args.campaignId,
      state: 'pending',
      expiresAt: { gt: new Date() },
    },
    select: { proposedValue: true },
  });

  const texts: string[] = [];
  for (const row of rows) {
    const value = row.proposedValue as { items?: Array<{ text?: unknown }> } | null;
    for (const item of value?.items ?? []) {
      if (typeof item?.text === 'string' && item.text.trim().length > 0) {
        texts.push(item.text);
      }
    }
  }
  return texts;
}

// ── insight_op proposals (D4 #40) ────────────────────────────────────────────
//
// Each non-NOOP D3 reconciliation op becomes ONE kind='insight_op'
// drive_change_proposals row — review-gated per the B1 ruling (2026-08-19):
// forward PROPOSES, review APPLIES. GUB's applyDecisions consumes the
// proposed_value payload (parseInsightOpPayload on its side is the wire
// contract) and writes insights + insight_changes transactionally on approve.
// NOOP ops never become cards — they're telemetry at most (pitfall #7).

/**
 * Stable identity of an op for dedup + the day-one idempotency key.
 *
 * Hashes the op's SEMANTIC content only: verb, container scope, target id and
 * final text. Volatile fields are deliberately excluded — confidence /
 * reasoning / retrieval vary run to run for the same logical op, and
 * targetUpdatedAt is the CAS snapshot, not identity (a re-scan that re-derives
 * the same op against a moved target must still dedup against the pending
 * card; a stale card self-heals at approve time via reject-and-regenerate).
 */
export function insightOpHash(op: InsightOp): string {
  const canonical = JSON.stringify({
    op: op.op,
    entityType: op.candidate.entityType,
    entityId: op.candidate.entityId,
    targetInsightId: op.targetInsightId ?? null,
    newText: op.op === 'UPDATE' ? op.newText ?? op.candidate.text : null,
    text: op.candidate.text,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** The op's final insight text — what lands in the store on approval
 *  (and therefore what gets embedded). */
export function insightOpFinalText(op: InsightOp): string {
  return op.op === 'UPDATE' ? op.newText ?? op.candidate.text : op.candidate.text;
}

export interface InsightOpProposalRow {
  kind: 'insight_op';
  entityType: 'account' | 'campaign';
  accountId: string;
  campaignId: string | null;
  property: string;
  proposedValue: Record<string, unknown>;
  reasoning: string;
  sourceFileIds: string[];
  confidence: number;
  opHash: string;
}

/**
 * Pure payload assembly (hermetic-suite seam — the DB writer below stays
 * thin). `embedding` is the final text's vector, computed by the caller in
 * one batch; GUB has no embedding stack, so the vector rides the proposal.
 */
export function buildInsightOpProposal(
  op: InsightOp,
  embedding: number[] | null,
): InsightOpProposalRow {
  const c = op.candidate;
  const opHash = insightOpHash(op);
  // An unresolved new-campaign candidate has a Drive folder ref as entityId —
  // no campaign row yet, so the proposal anchors on the account (the CHECK
  // requires an entity ref); GUB resolves folder → campaign id at approve.
  const campaignId =
    c.entityType === 'campaign' && c.entityStatus !== 'new' && !op.unresolvedEntity
      ? c.entityId
      : null;
  return {
    kind: 'insight_op',
    entityType: c.entityType,
    accountId: c.accountId,
    campaignId,
    // Sentinel — `property` is NOT NULL but names no column for this kind
    // (same contract as additional_update's '__note__').
    property: '__insight_op__',
    proposedValue: {
      op: op.op,
      ...(op.targetInsightId !== undefined ? { targetInsightId: op.targetInsightId } : {}),
      ...(op.targetUpdatedAt !== undefined ? { targetUpdatedAt: op.targetUpdatedAt } : {}),
      ...(op.op === 'UPDATE' ? { newText: op.newText ?? c.text } : {}),
      opHash,
      ...(embedding ? { embedding } : {}),
      candidate: c,
      ...(op.unresolvedEntity ? { unresolvedEntity: true } : {}),
      ...(op.demotedFrom !== undefined ? { demotedFrom: op.demotedFrom } : {}),
      // Telemetry for apply-side debugging + the eval; never prompt input.
      retrieval: op.retrieval,
    },
    reasoning: op.reasoning,
    sourceFileIds: c.sourceFileIds,
    confidence: op.confidence,
    opHash,
  };
}

export interface ProposeInsightOpsInput {
  ops: InsightOp[];
  reviewer: { reviewerEmail: string | null; reviewerStaffId: string | null };
  /** Attached at emit — the op itself carries no run provenance (D3 contract). */
  syncRunId: string;
  /** Injectable seam: embedding client (fail-soft — see below). */
  embed?: (texts: string[]) => Promise<number[][]>;
}

export interface ProposeInsightOpsResult {
  emitted: number;
  /** Ops skipped because an identical pending insight_op card exists. */
  duplicatesSkipped: number;
  noops: number;
}

export async function proposeInsightOps(
  input: ProposeInsightOpsInput,
): Promise<ProposeInsightOpsResult> {
  const embed = input.embed ?? embedTexts;
  const expiresAt = new Date(
    Date.now() + config.DRIVE_PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const emittable = input.ops.filter((op) => op.op !== 'NOOP');
  const noops = input.ops.length - emittable.length;
  if (emittable.length === 0) {
    return { emitted: 0, duplicatesSkipped: 0, noops };
  }

  // One embed call for the batch (the batch is the unit the API bills).
  // Fail-soft: a proposal without a vector is still reviewable/appliable —
  // GUB warns at apply and the row stays invisible to retrieval until
  // re-embedded. Losing the card entirely would be worse.
  let vectors: Array<number[] | null>;
  try {
    vectors = await embed(emittable.map((op) => insightOpFinalText(op)));
  } catch (err) {
    log(
      `      ⚠ insight-op embedding failed — proposing without vectors: ${err instanceof Error ? err.message : String(err)}`,
    );
    vectors = emittable.map(() => null);
  }

  let emitted = 0;
  let duplicatesSkipped = 0;
  for (const [i, op] of emittable.entries()) {
    const row = buildInsightOpProposal(op, vectors[i] ?? null);

    // Re-propose guard (the A1 duplicate-card lesson), keyed on
    // (entity, op-hash): an identical pending card means the reviewer
    // already has this op — every scan until they decide would stack
    // another copy. The hash ignores volatile fields, so a re-derived op
    // with only a fresher CAS snapshot still counts as identical; a stale
    // pending card self-heals at approve (reject-as-stale → re-propose).
    const pending = await prisma.driveChangeProposal.findFirst({
      where: {
        kind: 'insight_op',
        entityType: row.entityType,
        accountId: row.accountId,
        campaignId: row.campaignId,
        state: 'pending',
        proposedValue: { path: ['opHash'], equals: row.opHash },
      },
      select: { id: true },
    });
    if (pending) {
      duplicatesSkipped++;
      continue;
    }

    await prisma.driveChangeProposal.create({
      data: {
        kind: row.kind,
        entityType: row.entityType,
        accountId: row.accountId,
        campaignId: row.campaignId,
        property: row.property,
        currentValue: Prisma.JsonNull,
        proposedValue: row.proposedValue as unknown as Prisma.InputJsonValue,
        reasoning: row.reasoning,
        sourceFileIds: row.sourceFileIds,
        confidence: new Prisma.Decimal(row.confidence),
        state: 'pending',
        reviewToken: crypto.randomBytes(32).toString('hex'),
        reviewerEmail: input.reviewer.reviewerEmail,
        reviewerStaffId: input.reviewer.reviewerStaffId,
        expiresAt,
        syncRunId: input.syncRunId,
      },
    });
    emitted++;
  }

  log(
    `      → insight ops proposed for review: ${emitted}${duplicatesSkipped > 0 ? ` (${duplicatesSkipped} already pending)` : ''}${noops > 0 ? `, ${noops} NOOP (no card)` : ''}`,
  );
  return { emitted, duplicatesSkipped, noops };
}

async function writeNoteBatch(args: {
  entityType: 'account' | 'campaign';
  accountId: string | null;
  campaignId: string | null;
  items: ProposeNoteItem[];
  reviewer: { reviewerEmail: string | null; reviewerStaffId: string | null };
  expiresAt: Date;
}): Promise<void> {
  const unionSources = Array.from(
    new Set(args.items.flatMap((n) => n.source_file_ids)),
  );
  await prisma.driveChangeProposal.create({
    data: {
      kind: 'additional_update',
      // Sentinel — `property` is NOT NULL but doesn't name a column for
      // this kind (mirrors distillAndEmit's contract with the review UI).
      property: '__note__',
      entityType: args.entityType,
      accountId: args.accountId,
      campaignId: args.campaignId,
      currentValue: Prisma.JsonNull,
      proposedValue: { items: args.items } as unknown as Prisma.InputJsonValue,
      reasoning: null,
      sourceFileIds: unionSources,
      confidence: null,
      state: 'pending',
      reviewToken: crypto.randomBytes(32).toString('hex'),
      ...args.reviewer,
      expiresAt: args.expiresAt,
    },
  });
}
