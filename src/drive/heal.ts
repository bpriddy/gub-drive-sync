/**
 * drive.heal.ts — auto-apply structured-field extraction from already-
 * approved status_markdown.
 *
 * Why this exists: the regular distillation pipeline can fail to map
 * facts into structured fields (LLM picks wrong field name, value
 * doesn't validate, prompt happens to miss it). Rescue-to-note preserves
 * the content as a note inside the status_markdown — so the FACT is
 * still in the system, just not in queryable structured form. Heal
 * closes that gap by reading the markdown back and extracting any
 * structured fields it confidently supports.
 *
 * Why this is auto-apply (NOT a proposal-and-review flow):
 *   Heal operates on the status_markdown the reviewer has ALREADY seen
 *   and approved. Asking them to re-review structured extractions of
 *   already-approved content would be redundant noise. The trust is
 *   transferred from the markdown approval to the heal extraction.
 *
 * Safety:
 *   - The prompt has a strict "HIGH CONFIDENCE only" gate
 *   - Every heal write goes into campaign_changes / account_changes
 *     (audit trail; manually reversible)
 *   - changed_by = DRIVE_SYNC_SYSTEM_STAFF_ID (deterministic; queryable
 *     to find "everything Heal touched")
 *   - Values pass through the same validateProposedValue + isNoOpChange
 *     guards as regular proposals — invalid or no-op writes are
 *     dropped silently
 *
 * Lifecycle in scanEntity:
 *   1. heal(entity) — FIRST step; pulls structured form from existing markdown
 *   2. scanFolder → bucket
 *   3. distillAndEmit(bucket) — new content goes through normal review
 *   4. (after review approvals) status_markdown is re-synthesized
 *   5. NEXT scan: heal sees the new markdown, may extract more structured fields
 */

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { runPreset, parseLlmJson } from '../ai';
import { SchemaType, type Schema } from '@google/generative-ai';
import {
  ACCOUNT_WRITABLE_FIELDS,
  CAMPAIGN_WRITABLE_FIELDS,
  isNoOpChange,
  validateProposedValue,
  type AccountCurrentState,
  type CampaignCurrentState,
} from './schema';

/**
 * Deterministic UUID of the seeded "Drive Sync (system)" staff row.
 * Created by migration 20260525100000_loosen_drive_proposal_check_and_seed_drive_sync_staff.
 * Used as changed_by for any auto-applied write (heal, future backfill)
 * so the audit trail clearly distinguishes machine writes from human ones.
 */
export const DRIVE_SYNC_SYSTEM_STAFF_ID = 'dcd5d8e3-0000-4000-a000-000000000001';

export interface HealInput {
  entityType: 'account' | 'campaign';
  accountId: string | null;
  campaignId: string | null;
  entityName: string;
  currentStatusMarkdown: string | null;
  currentState: AccountCurrentState | CampaignCurrentState;
}

export interface HealResult {
  fieldsApplied: number;
  fieldsSkippedInvalid: number;
  fieldsSkippedNoOp: number;
  driver: string;
}

const HealFieldChangeSchema = z.object({
  field: z.string(),
  proposed_value: z.string().nullable().optional(),
  reasoning: z.string(),
});

const HealResponseSchema = z.object({
  field_changes: z.array(HealFieldChangeSchema).default([]),
});

function healResponseSchema(entityType: 'account' | 'campaign'): Schema {
  const fields =
    entityType === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS;
  return {
    type: SchemaType.OBJECT,
    properties: {
      field_changes: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            field: {
              type: SchemaType.STRING,
              format: 'enum',
              enum: [...fields],
            },
            proposed_value: { type: SchemaType.STRING, nullable: true },
            reasoning: { type: SchemaType.STRING },
          },
          required: ['field', 'reasoning'],
        },
      },
    },
    required: ['field_changes'],
  };
}

/**
 * Map writable-field key → entity-column key. Same map as in
 * drive.schema.ts's ACCOUNT_FIELD_WRITE / CAMPAIGN_FIELD_WRITE. Kept
 * local here to avoid pulling extra symbols; if it drifts, update both.
 */
const ACCOUNT_ENTITY_COLUMN: Record<string, string> = {
  status: 'status',
  account_exec_staff_id: 'accountExecStaffId',
  industry: 'industry',
  primary_contact_name: 'primaryContactName',
  primary_contact_email: 'primaryContactEmail',
  notes: 'notes',
};
const CAMPAIGN_ENTITY_COLUMN: Record<string, string> = {
  status: 'status',
  budget: 'budget',
  awarded_at: 'awardedAt',
  live_at: 'liveAt',
  ends_at: 'endsAt',
};

const ACCOUNT_CHANGE_KIND: Record<string, 'text' | 'uuid' | 'date'> = {
  status: 'text',
  account_exec_staff_id: 'uuid',
  industry: 'text',
  primary_contact_name: 'text',
  primary_contact_email: 'text',
  notes: 'text',
};
const CAMPAIGN_CHANGE_KIND: Record<string, 'text' | 'uuid' | 'date'> = {
  status: 'text',
  budget: 'text',
  awarded_at: 'date',
  live_at: 'date',
  ends_at: 'date',
};

export async function healFromMarkdown(input: HealInput): Promise<HealResult> {
  const baseResult: HealResult = {
    fieldsApplied: 0,
    fieldsSkippedInvalid: 0,
    fieldsSkippedNoOp: 0,
    driver: 'none',
  };

  // No markdown → nothing to heal from. Skip silently.
  if (!input.currentStatusMarkdown || input.currentStatusMarkdown.trim().length === 0) {
    return baseResult;
  }

  const writableFields =
    input.entityType === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS;

  const completion = await runPreset({
    key: 'drive.field_heal.v1',
    responseSchema: healResponseSchema(input.entityType),
    variables: {
      entity_type: input.entityType,
      entity_name: input.entityName,
      writable_fields_json: JSON.stringify(writableFields),
      current_state_json: JSON.stringify(input.currentState, null, 2),
      status_markdown: input.currentStatusMarkdown,
    },
  });

  let parsed: z.infer<typeof HealResponseSchema>;
  try {
    parsed = HealResponseSchema.parse(parseLlmJson(completion.text));
  } catch (err) {
    logger.error(
      { err, entityType: input.entityType, raw: completion.text.slice(0, 400) },
      '[drive.heal] LLM response parse failed — heal skipped this run',
    );
    return { ...baseResult, driver: completion.driver };
  }

  if (parsed.field_changes.length === 0) {
    return { ...baseResult, driver: completion.driver };
  }

  let fieldsApplied = 0;
  let fieldsSkippedInvalid = 0;
  let fieldsSkippedNoOp = 0;

  for (const change of parsed.field_changes) {
    const validation = validateProposedValue(
      input.entityType,
      change.field,
      change.proposed_value ?? null,
    );
    if (!validation.ok) {
      fieldsSkippedInvalid++;
      logger.debug(
        { entityType: input.entityType, field: change.field, reason: validation.reason },
        '[drive.heal] LLM proposed an invalid value — skipping',
      );
      continue;
    }

    const currentValue = (input.currentState as Record<string, unknown>)[change.field] ?? null;
    if (isNoOpChange(input.entityType, change.field, currentValue, validation.value)) {
      fieldsSkippedNoOp++;
      continue;
    }

    const entityColumn =
      input.entityType === 'account'
        ? ACCOUNT_ENTITY_COLUMN[change.field]
        : CAMPAIGN_ENTITY_COLUMN[change.field];
    const changeKind =
      input.entityType === 'account'
        ? ACCOUNT_CHANGE_KIND[change.field]
        : CAMPAIGN_CHANGE_KIND[change.field];
    if (!entityColumn || !changeKind) {
      // Validation passed but our local maps don't know the field — shouldn't
      // happen unless allowlist diverges. Defensive.
      logger.warn(
        { field: change.field, entityType: input.entityType },
        '[drive.heal] field passed allowlist but missing from entity-column map; skipping',
      );
      fieldsSkippedInvalid++;
      continue;
    }

    const finalValue = validation.value;

    // Transactional: update entity + log change in *_changes.
    try {
      await prisma.$transaction(async (tx) => {
        // Project the value into the right column shape for the change log.
        const previousValue = currentValue;
        const previousValueCols = projectChangeValue(changeKind, previousValue, 'previous');
        const newValueCols = projectChangeValue(changeKind, finalValue, 'new');

        if (input.entityType === 'account' && input.accountId) {
          await tx.account.update({
            where: { id: input.accountId },
            data: { [entityColumn]: castToEntity(changeKind, finalValue) } as Prisma.AccountUpdateInput,
          });
          await tx.accountChange.create({
            data: {
              accountId: input.accountId,
              property: change.field,
              ...previousValueCols,
              ...newValueCols,
              changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
            },
          });
        } else if (input.entityType === 'campaign' && input.campaignId) {
          await tx.campaign.update({
            where: { id: input.campaignId },
            data: { [entityColumn]: castToEntity(changeKind, finalValue) } as Prisma.CampaignUpdateInput,
          });
          await tx.campaignChange.create({
            data: {
              campaignId: input.campaignId,
              property: change.field,
              ...previousValueCols,
              ...newValueCols,
              changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
            },
          });
        }
      });
      fieldsApplied++;
      logger.info(
        { entityType: input.entityType, field: change.field, value: String(finalValue) },
        '[drive.heal] auto-applied structured field from status_markdown',
      );
    } catch (err) {
      fieldsSkippedInvalid++;
      logger.error(
        { err, entityType: input.entityType, field: change.field },
        '[drive.heal] failed to apply heal write',
      );
    }
  }

  return {
    fieldsApplied,
    fieldsSkippedInvalid,
    fieldsSkippedNoOp,
    driver: completion.driver,
  };
}

// ── value-projection helpers (mirror drive.review.ts's projectValue) ────────

function projectChangeValue(
  kind: 'text' | 'uuid' | 'date',
  value: unknown,
  side: 'new' | 'previous',
): Record<string, string | Date | null> {
  const keyPrefix = side === 'new' ? 'value' : 'previousValue';
  const suffix = kind === 'text' ? 'Text' : kind === 'uuid' ? 'Uuid' : 'Date';
  const key = `${keyPrefix}${suffix}`;
  if (value === null || value === undefined) return { [key]: null };
  if (kind === 'date') {
    const s = typeof value === 'string' ? value : String(value);
    return { [key]: new Date(`${s}T00:00:00Z`) };
  }
  const s = typeof value === 'string' ? value : String(value);
  return { [key]: s };
}

function castToEntity(kind: 'text' | 'uuid' | 'date', value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'text':
      return typeof value === 'string' ? value : String(value);
    case 'uuid':
      return typeof value === 'string' ? value : String(value);
    case 'date': {
      const s = typeof value === 'string' ? value : String(value);
      return new Date(`${s}T00:00:00Z`);
    }
  }
}

// Unused but exported for testing/exploration use.
export const _internal = { projectChangeValue, castToEntity };

// Silence eslint about unused import in some builds.
void crypto;
