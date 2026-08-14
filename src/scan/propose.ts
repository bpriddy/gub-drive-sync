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
        text: `[new campaign candidate "${input.entityName}"] ${vc.field}: ${vc.proposedValueRaw ?? '(null)'}`,
        source_file_ids: [] as string[],
      })),
      ...notes.map((n) => ({
        text: `[new campaign candidate "${input.entityName}"] ${n.text}`,
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
        reasoning: null,
        sourceFileIds: [],
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
