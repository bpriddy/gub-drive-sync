/**
 * structured-output.ts — Gemini responseSchema builders.
 *
 * Gemini's structured output uses an OpenAPI-subset schema. We build ours
 * dynamically from the allowlists in drive.schema.ts so adding a field is
 * one migration + one allowlist line — no prompt edits.
 *
 * Two schemas live here:
 *   - perFileResponseSchema()  → { account: Observation[], campaign: Observation[] }
 *   - distillationResponseSchema() → the per-entity distilled output
 *
 * `proposed_value` is always a STRING in the schema (Gemini doesn't support
 * union types well). Callers must run drive.schema.validateProposedValue
 * before persisting.
 */

import { SchemaType, type Schema } from '@google/generative-ai';
import { ACCOUNT_WRITABLE_FIELDS, CAMPAIGN_WRITABLE_FIELDS } from './schema';

/** One observation in the per-file response. */
function observationItemSchema(fieldEnum: readonly string[]): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      kind: {
        type: SchemaType.STRING,
        format: 'enum',
        enum: ['field_change', 'note'],
        description:
          'field_change: proposes a value for one of the entity fields. note: a relevant observation that does not map to a writable field.',
      },
      field: {
        type: SchemaType.STRING,
        format: 'enum',
        enum: [...fieldEnum],
        nullable: true,
        description:
          'Required when kind=field_change. Must be one of the writable fields. Omit/null for kind=note.',
      },
      proposed_value: {
        type: SchemaType.STRING,
        nullable: true,
        description:
          'The proposed new value as a string. For dates use YYYY-MM-DD, for uuids use the raw uuid, for numbers use the decimal string. Null = propose clearing the field. Omit/null for kind=note.',
      },
      note_text: {
        type: SchemaType.STRING,
        nullable: true,
        description: 'Free-text observation. Required when kind=note, omit/null for kind=field_change.',
      },
      reasoning: {
        type: SchemaType.STRING,
        description: 'One-sentence justification citing what in the file implies this observation.',
      },
      confidence: {
        type: SchemaType.NUMBER,
        description: '0.0–1.0 — your subjective certainty.',
      },
    },
    required: ['kind', 'reasoning', 'confidence'],
  };
}

export function perFileResponseSchema(): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      account: {
        type: SchemaType.ARRAY,
        description:
          'Observations that apply to the account entity. Empty array if the file implies no change vs current account state.',
        items: observationItemSchema(ACCOUNT_WRITABLE_FIELDS),
      },
      campaign: {
        type: SchemaType.ARRAY,
        description:
          'Observations that apply to the campaign entity. Empty array if the file implies no change vs current campaign state, or the file is not campaign-relevant.',
        items: observationItemSchema(CAMPAIGN_WRITABLE_FIELDS),
      },
    },
    required: ['account', 'campaign'],
  };
}

// ── Distillation ────────────────────────────────────────────────────────────

function distillationFieldChangeItem(fieldEnum: readonly string[]): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      field: {
        type: SchemaType.STRING,
        format: 'enum',
        enum: [...fieldEnum],
      },
      proposed_value: {
        type: SchemaType.STRING,
        nullable: true,
      },
      reasoning: { type: SchemaType.STRING },
      source_file_ids: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
      confidence: { type: SchemaType.NUMBER },
    },
    required: ['field', 'reasoning', 'source_file_ids', 'confidence'],
  };
}

function distillationNoteItem(): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      text: { type: SchemaType.STRING },
      source_file_ids: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
    },
    required: ['text', 'source_file_ids'],
  };
}

function distillationAmbiguousItem(): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      text: { type: SchemaType.STRING },
      source_file_ids: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
      reasoning: { type: SchemaType.STRING, nullable: true },
    },
    required: ['text', 'source_file_ids'],
  };
}

export function distillationResponseSchema(entity: 'account' | 'campaign'): Schema {
  const fields = entity === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS;
  return {
    type: SchemaType.OBJECT,
    properties: {
      field_changes: {
        type: SchemaType.ARRAY,
        items: distillationFieldChangeItem(fields),
      },
      notes: {
        type: SchemaType.ARRAY,
        items: distillationNoteItem(),
      },
      ambiguous: {
        type: SchemaType.ARRAY,
        items: distillationAmbiguousItem(),
      },
    },
    required: ['field_changes', 'notes', 'ambiguous'],
  };
}

// ── New-entity discovery ────────────────────────────────────────────────────

/**
 * Schema for discovery — "given this folder + its files, propose the initial
 * field values for a new account (or campaign)." One response per folder.
 *
 * Each writable field appears as an optional string property; missing/null
 * means "no proposal for that field". A `name` field is always required
 * (entity name is mandatory in the DB), plus reasoning + confidence
 * covering the whole proposal.
 *
 * Unlike field_change proposals, there's no current_state to compare against —
 * we're constructing the entity from scratch. Post-LLM, each non-null field
 * becomes one proposal row, and they're grouped by proposal_group_id.
 */
export function newEntityResponseSchema(entity: 'account' | 'campaign'): Schema {
  const fields = entity === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS;

  const fieldProperties: Record<string, Schema> = {
    name: {
      type: SchemaType.STRING,
      description: `Proposed ${entity} name. Usually the folder name, possibly cleaned up.`,
    },
  };
  for (const f of fields) {
    fieldProperties[f] = {
      type: SchemaType.STRING,
      nullable: true,
      description: `Proposed initial value for ${f}. Null/omit if the folder contents don't support a confident proposal for this field.`,
    };
  }

  return {
    type: SchemaType.OBJECT,
    properties: {
      // Whether we believe this folder should become a new entity at all.
      is_entity: {
        type: SchemaType.BOOLEAN,
        description:
          'True if this folder appears to represent a real new ${entity}. False if it looks like a misplaced folder, scratchpad, archive, template, etc.',
      },
      skip_reason: {
        type: SchemaType.STRING,
        nullable: true,
        description: 'When is_entity=false, a short reason. Omit otherwise.',
      },
      proposal: {
        type: SchemaType.OBJECT,
        nullable: true,
        description: 'The proposed entity fields. Null when is_entity=false.',
        properties: fieldProperties,
        required: ['name'],
      },
      reasoning: { type: SchemaType.STRING },
      confidence: { type: SchemaType.NUMBER },
    },
    required: ['is_entity', 'reasoning', 'confidence'],
  };
}

