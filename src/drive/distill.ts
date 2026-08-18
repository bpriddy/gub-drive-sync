/**
 * drive.distill.ts — Per-entity distillation + proposal/scan-log emission.
 *
 * Input: an array of Observations accumulated across a scan for one entity
 *        (account OR campaign, separately), plus the entity's current state.
 * Output:
 *   - drive_change_proposals rows for accepted field_changes
 *   - drive_scan_logs rows for notes + ambiguous items
 *
 * Guards:
 *   - Validates proposed_value against drive.schema validators. Invalid → ambiguous log.
 *   - Runs a no-op filter: if proposed value equals current (loose equality
 *     for free-text fields), drop silently. The LLM sometimes re-proposes
 *     identical values after whitespace/case tweaks; we don't need that noise.
 *
 * Called by the orchestrator, once per entity per scan.
 */

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { parseLlmJson, runPreset } from '../ai';
import { writeScanLog } from './logs';
import {
  ACCOUNT_WRITABLE_FIELDS,
  CAMPAIGN_WRITABLE_FIELDS,
  isNoOpChange,
  validateProposedValue,
} from './schema';
import { distillationResponseSchema } from './structured-output';
import type { AccountObservation, CampaignObservation } from './interpret';

// Account/campaign distilled shapes share structure but differ by field enum.
const DistilledFieldChangeSchema = z.object({
  field: z.string(),
  proposed_value: z.string().nullable().optional(),
  reasoning: z.string(),
  source_file_ids: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

const DistilledNoteSchema = z.object({
  text: z.string(),
  source_file_ids: z.array(z.string()).default([]),
});

const DistilledAmbiguousSchema = z.object({
  text: z.string(),
  source_file_ids: z.array(z.string()).default([]),
  reasoning: z.string().nullable().optional(),
});

const DistillResponseSchema = z.object({
  field_changes: z.array(DistilledFieldChangeSchema).default([]),
  notes: z.array(DistilledNoteSchema).default([]),
  ambiguous: z.array(DistilledAmbiguousSchema).default([]),
});

// Observation-with-source used internally; orchestrator supplies it.
export interface SourcedAccountObservation {
  observation: AccountObservation;
  sourceFileId: string;
}
export interface SourcedCampaignObservation {
  observation: CampaignObservation;
  sourceFileId: string;
}

export interface DistillAndEmitInput {
  entityType: 'account' | 'campaign';
  accountId: string | null;
  campaignId: string | null;
  syncRunId: string | null;
  /** Each observation tagged with the file it came from. */
  observations: Array<
    | SourcedAccountObservation
    | SourcedCampaignObservation
  >;
  currentState: Record<string, unknown>;
  reviewerEmail?: string | null;
  reviewerStaffId?: string | null;
}

export interface DistillAndEmitResult {
  proposalsCreated: number;
  proposalsDroppedNoOp: number;
  proposalsDroppedInvalid: number;
  notesWritten: number;
  ambiguousWritten: number;
  driver: string;
}

export async function distillAndEmit(input: DistillAndEmitInput): Promise<DistillAndEmitResult> {
  const baseResult: DistillAndEmitResult = {
    proposalsCreated: 0,
    proposalsDroppedNoOp: 0,
    proposalsDroppedInvalid: 0,
    notesWritten: 0,
    ambiguousWritten: 0,
    driver: 'none',
  };

  if (input.observations.length === 0) {
    return baseResult;
  }

  // Shape the observations for the distillation prompt — flatten the sourceFileId in.
  const observationsForPrompt = input.observations.map((o) => ({
    ...o.observation,
    source_file_id: o.sourceFileId,
  }));

  const completion = await runPreset({
    key: 'drive.distillation.v1',
    responseSchema: distillationResponseSchema(input.entityType),
    variables: {
      entity_type: input.entityType,
      writable_fields_json: JSON.stringify(
        input.entityType === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS,
      ),
      observations_json: JSON.stringify(observationsForPrompt, null, 2),
      current_state_json: JSON.stringify(input.currentState, null, 2),
      // Always-empty here: the already-on-record suppression is a scan-core
      // propose-path concern (see runDistillation's knownFacts). Passed
      // explicitly so the preset doesn't warn about an unbound variable.
      known_facts_json: '[]',
    },
  });

  let distilled: z.infer<typeof DistillResponseSchema>;
  try {
    const parsed = parseLlmJson(completion.text);
    distilled = DistillResponseSchema.parse(parsed);
  } catch (err) {
    logger.error(
      { err, entityType: input.entityType, raw: completion.text.slice(0, 400) },
      '[drive.distill] parse failed — logging as llm_error',
    );
    await writeScanLog({
      syncRunId: input.syncRunId,
      accountId: input.accountId,
      campaignId: input.campaignId,
      level: 'error',
      category: 'llm_error',
      message: 'Distillation response could not be parsed',
      payload: { rawPreview: completion.text.slice(0, 400) },
    });
    return { ...baseResult, driver: completion.driver };
  }

  const expiresAt = new Date(Date.now() + config.DRIVE_PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000);

  let proposalsCreated = 0;
  let proposalsDroppedNoOp = 0;
  let proposalsDroppedInvalid = 0;

  // Rescue-to-note: when a field_change fails validation (unknown field
  // or value can't be coerced), we DEMOTE the observation into the notes
  // batch instead of throwing it into drive_scan_logs where nobody sees it.
  // Principle: the LLM's signal is preserved; structural failure becomes
  // graceful content preservation. Reviewer judges the text as content,
  // not schema. See docs/status-markdown-plan.md "structured vs note"
  // discussion for the full architectural rationale.
  const rescuedNotes: Array<{ text: string; source_file_ids: string[] }> = [];

  for (const change of distilled.field_changes) {
    // Validate proposed_value against the field's Zod validator.
    const validation = validateProposedValue(input.entityType, change.field, change.proposed_value ?? null);
    if (!validation.ok) {
      proposalsDroppedInvalid++;
      // Rescue the LLM's text into the additional_update bucket so the
      // reviewer still sees it (and the synthesis prompt still uses it).
      rescuedNotes.push({
        text: `${change.field}: ${change.proposed_value ?? '(none)'} — ${change.reasoning}`,
        source_file_ids: change.source_file_ids,
      });
      // Separately log a 'structural_demote' diagnostic for dev observability —
      // not reviewer-visible. Helps the team see "we keep failing on field X"
      // as a signal to consider adding it to the allowlist.
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: input.accountId,
        campaignId: input.campaignId,
        level: 'warn',
        category: 'diagnostic',
        message: `Structural demote: ${input.entityType}.${change.field} (${validation.reason})`,
        payload: {
          attempted_field: change.field,
          rawProposed: change.proposed_value ?? null,
          reason: validation.reason,
          sourceFileIds: change.source_file_ids,
        },
      });
      continue;
    }

    const currentValue = input.currentState[change.field] ?? null;
    if (isNoOpChange(input.entityType, change.field, currentValue, validation.value)) {
      proposalsDroppedNoOp++;
      continue;
    }

    const currentJson = (currentValue as Prisma.InputJsonValue | null) === null
      ? Prisma.JsonNull
      : (currentValue as Prisma.InputJsonValue);
    const proposedJson = validation.value === null
      ? Prisma.JsonNull
      : (validation.value as Prisma.InputJsonValue);

    await prisma.driveChangeProposal.create({
      data: {
        syncRunId: input.syncRunId,
        entityType: input.entityType,
        accountId: input.accountId,
        campaignId: input.campaignId,
        property: change.field,
        currentValue: currentJson,
        proposedValue: proposedJson,
        reasoning: change.reasoning,
        sourceFileIds: change.source_file_ids,
        confidence: new Prisma.Decimal(change.confidence),
        state: 'pending',
        reviewToken: crypto.randomBytes(32).toString('hex'),
        reviewerEmail: input.reviewerEmail ?? null,
        reviewerStaffId: input.reviewerStaffId ?? null,
        expiresAt,
      },
    });
    proposalsCreated++;
  }

  // Notes are promoted to ONE additional_update proposal row per scan
  // per entity (instead of N scan log rows). The reviewer sees a single
  // card with the batched items and approves/rejects the batch — what
  // they approve gets fed into the post-approval status_markdown
  // synthesis. See docs/status-markdown-plan.md.
  //
  // Items shape stays close to what distillation produced — each note
  // carries (text, source_file_ids[]) — so we don't lose information.
  // The row-level `sourceFileIds` carries the union of all items'
  // sources for indexed lookup.
  // Merge rescued field_change demotions into the notes batch — these
  // are the LLM observations whose proposed field/value didn't fit our
  // allowlist but whose content is still worth preserving for the
  // reviewer + synthesis pipeline.
  const allNoteItems = [
    ...distilled.notes.map((n) => ({ text: n.text, source_file_ids: n.source_file_ids })),
    ...rescuedNotes,
  ];

  let notesWritten = 0;
  if (allNoteItems.length > 0) {
    const items = allNoteItems;
    const unionSources = Array.from(
      new Set(items.flatMap((n) => n.source_file_ids)),
    );

    await prisma.driveChangeProposal.create({
      data: {
        kind: 'additional_update',
        // Sentinel — `property` is NOT NULL on the table but doesn't
        // name a column for this kind. Reviewer UI keys off `kind`,
        // not `property`. Keep stable so anyone querying by
        // (kind='additional_update', property='__note__') gets a clean
        // result.
        property: '__note__',
        syncRunId: input.syncRunId,
        entityType: input.entityType,
        accountId: input.accountId,
        campaignId: input.campaignId,
        currentValue: Prisma.JsonNull,
        proposedValue: { items } as Prisma.InputJsonValue,
        // Batch-level reasoning/confidence don't carry meaningful
        // per-item signal — left null. Items array is the contract.
        reasoning: null,
        sourceFileIds: unionSources,
        confidence: null,
        state: 'pending',
        reviewToken: crypto.randomBytes(32).toString('hex'),
        reviewerEmail: input.reviewerEmail ?? null,
        reviewerStaffId: input.reviewerStaffId ?? null,
        expiresAt,
      },
    });
    notesWritten = items.length;
  }

  let ambiguousWritten = 0;
  for (const a of distilled.ambiguous) {
    await writeScanLog({
      syncRunId: input.syncRunId,
      accountId: input.accountId,
      campaignId: input.campaignId,
      level: 'warn',
      category: 'ambiguous',
      message: a.text,
      payload: { sourceFileIds: a.source_file_ids, reasoning: a.reasoning ?? null },
    });
    ambiguousWritten++;
  }

  return {
    proposalsCreated,
    proposalsDroppedNoOp,
    proposalsDroppedInvalid,
    notesWritten,
    ambiguousWritten,
    driver: completion.driver,
  };
}
