/**
 * structured-output.ts — Gemini responseSchema builders.
 *
 * Gemini's structured output uses an OpenAPI-subset schema. We build ours
 * dynamically from the allowlists in drive.schema.ts so adding a field is
 * one migration + one allowlist line — no prompt edits.
 *
 * Two schemas live here:
 *   - perFileResponseSchema()  → { account: Observation[], campaign: Observation[] }
 *     Per-file extractor produces FLAT observations (text + reasoning +
 *     confidence). No classification, no writable-field knowledge. The
 *     extractor's job is just "what does this file reveal about the
 *     entity?" — Gemini is trusted as a marketing-domain expert.
 *
 *   - distillationResponseSchema() → per-entity classified output
 *     Distillation step is where the writable-field allowlist + current
 *     state come in. It classifies each observation into field_changes
 *     / notes / ambiguous and culls no-ops.
 */

import { SchemaType, type Schema } from '@google/generative-ai';
import { ACCOUNT_WRITABLE_FIELDS, CAMPAIGN_WRITABLE_FIELDS } from './schema';

/**
 * One observation in the per-file response. Deliberately flat — the
 * per-file step doesn't know about writable fields or current state;
 * those concerns belong to distillation.
 */
function observationItemSchema(): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      text: {
        type: SchemaType.STRING,
        description:
          'A concise statement of what the file reveals about the entity. One sentence, no preamble. e.g. "Launch date shifted from May to June 1." or "Brand positioning is dark, cinematic, neo-noir."',
      },
      reasoning: {
        type: SchemaType.STRING,
        description: 'One-sentence justification citing what in the file implies this observation.',
      },
      confidence: {
        type: SchemaType.NUMBER,
        description: '0.0–1.0 — your subjective certainty.',
      },
      entity_campaign_name: {
        type: SchemaType.STRING,
        nullable: true,
        description:
          'For campaign[] observations: the verbatim name of the campaign this observation is about. Prefer a match from KNOWN_CAMPAIGNS provided in the prompt. Emit a fresh name from the source if the file genuinely references an unknown campaign — the orchestrator does a similarity check and either matches to a known campaign or creates a new candidate. NULL/omitted for account[] observations.',
      },
    },
    required: ['text', 'reasoning', 'confidence'],
  };
}

export function perFileResponseSchema(): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      deck_type: {
        type: SchemaType.STRING,
        format: 'enum',
        enum: ['pitch', 'creative_review', 'other'],
        description:
          'Classify THIS FILE: "pitch" (creative concepts proposed to win/answer a brief), "creative_review" (creative presented for feedback/approval during development), or "other" (everything else). Gates downstream idea extraction — when unsure, "other".',
      },
      account: {
        type: SchemaType.ARRAY,
        description:
          'Observations about the account entity. Be liberal — emit any observation that helps a human understand the account from this file. Empty array only when the file is purely administrative or unrelated.',
        items: observationItemSchema(),
      },
      campaign: {
        type: SchemaType.ARRAY,
        description:
          'Observations about the campaign entity. Empty array when there is no campaign in scope or the file is not campaign-relevant.',
        items: observationItemSchema(),
      },
    },
    required: ['deck_type', 'account', 'campaign'],
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

// ── Structure resolution (Stage 1) ──────────────────────────────────────────

/**
 * Schema for the structure-resolution pass — "given this account's
 * folder tree (folders only) + the campaigns already known in the DB,
 * classify which folders are campaign roots vs account-level material."
 *
 * Returns a list of classified folders. The caller treats any folder NOT
 * present in the list as account-level by default (nothing is ignored —
 * unmentioned folders still get scanned, just attributed to the account).
 * So the LLM only needs to surface campaign roots (existing + new) and
 * notable account-level collections.
 */
export function structureResolutionResponseSchema(): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      folders: {
        type: SchemaType.ARRAY,
        description:
          'Classified folders. Surface every campaign-root folder (existing + new) and any notable account-level collection. Folders you omit are treated as account-level.',
        items: {
          type: SchemaType.OBJECT,
          properties: {
            folder_id: { type: SchemaType.STRING },
            folder_path: { type: SchemaType.STRING },
            classification: {
              type: SchemaType.STRING,
              format: 'enum',
              enum: ['existing_campaign', 'new_campaign', 'account_level'],
            },
            campaign_name: {
              type: SchemaType.STRING,
              nullable: true,
              description:
                'For campaign classifications: the campaign name. For existing_campaign, echo the matched campaign name. Null for account_level.',
            },
            matched_campaign_id: {
              type: SchemaType.STRING,
              nullable: true,
              description:
                'For existing_campaign ONLY: the campaign id from the EXISTING CAMPAIGNS anchor list whose folder this is. Null otherwise.',
            },
            reasoning: {
              type: SchemaType.STRING,
              description: 'One sentence: why this classification.',
            },
          },
          required: ['folder_id', 'folder_path', 'classification', 'reasoning'],
        },
      },
    },
    required: ['folders'],
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

