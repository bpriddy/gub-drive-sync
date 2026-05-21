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

  for (const change of distilled.field_changes) {
    // Validate proposed_value against the field's Zod validator.
    const validation = validateProposedValue(input.entityType, change.field, change.proposed_value ?? null);
    if (!validation.ok) {
      proposalsDroppedInvalid++;
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: input.accountId,
        campaignId: input.campaignId,
        level: 'warn',
        category: 'ambiguous',
        message: `Invalid proposed value for ${input.entityType}.${change.field}: ${validation.reason}`,
        payload: {
          field: change.field,
          rawProposed: change.proposed_value ?? null,
          sourceFileIds: change.source_file_ids,
          reasoning: change.reasoning,
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

  let notesWritten = 0;
  for (const note of distilled.notes) {
    await writeScanLog({
      syncRunId: input.syncRunId,
      accountId: input.accountId,
      campaignId: input.campaignId,
      level: 'note',
      category: 'uncategorized_insight',
      message: note.text,
      payload: { sourceFileIds: note.source_file_ids },
    });
    notesWritten++;
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
