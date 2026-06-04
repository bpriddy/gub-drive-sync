/**
 * drive.interpret.ts — Per-file Gemini call (preset: drive.file_extraction.v1).
 *
 * Per-file step is a PURE CONTEXT EXTRACTOR. It sees the file content and
 * the entity names; it does NOT see the writable-field allowlist or
 * current state. The LLM's job is just: "what does this file reveal?"
 *
 * Trusting Gemini as a marketing/agency domain expert: it knows what
 * matters about a project (positioning, milestones, team, decisions,
 * risks, deliverables, etc.) without us having to enumerate fields.
 *
 * Output: { account: Observation[], campaign: Observation[] } where
 * each Observation is just (text, reasoning, confidence). The
 * orchestrator buckets observations across all files in a scan; the
 * distillation step takes those flat observations + entity state +
 * writable_fields and does classification (field_change / note /
 * ambiguous) + dedup + no-op culling.
 */

import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { parseLlmJson, runPreset } from '../ai';
import type { AccountCurrentState, CampaignCurrentState } from './schema';
import { perFileResponseSchema } from './structured-output';
import type { TraversedFile } from './types';

// ── Response shape (schema-enforced by Gemini; Zod revalidates) ─────────────

const ObservationSchema = z.object({
  text: z.string(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
  // Subject-routing tag. Set on campaign[] obs whose subject is a
  // specific named campaign. The orchestrator does name-matching against
  // the known campaign list and either routes to that bucket or — when
  // unmatched — opens a new-candidate bucket by this name. Optional/
  // nullable; absent on account[] obs and on campaign[] obs that don't
  // name a specific campaign.
  entity_campaign_name: z.string().nullable().optional(),
});

const PerFileResponseSchema = z.object({
  account: z.array(ObservationSchema).default([]),
  campaign: z.array(ObservationSchema).default([]),
});

export type AccountObservation = z.infer<typeof ObservationSchema>;
export type CampaignObservation = z.infer<typeof ObservationSchema>;

/** Enriched with the source file id once the orchestrator receives it. */
export interface SourcedObservation<T> {
  observation: T;
  sourceFileId: string;
}

export interface InterpretFileInput {
  file: TraversedFile;
  text: string;
  accountName: string | null;
  /**
   * Current state is no longer passed to the per-file prompt — it's
   * deliberately omitted so the extractor stays a pure content
   * extractor. Distillation receives it instead. We still accept it
   * in the input type so callers don't need to change immediately;
   * it just isn't surfaced into the prompt variables.
   */
  accountCurrentState: AccountCurrentState;
  campaignName: string | null;
  campaignCurrentState: CampaignCurrentState | null;
  /**
   * Verbatim names of all campaigns known for this account — existing
   * DB rows AND new-candidate folders from the structure scan. Used by
   * the prompt as the vocabulary for entity_campaign_name routing.
   * Empty array = no campaigns discovered yet; campaign[] obs will
   * either fall back to the file's owning campaign or open phantom-name
   * buckets when the orchestrator processes them.
   */
  knownCampaigns?: string[];
}

export interface InterpretFileOutput {
  account: AccountObservation[];
  campaign: CampaignObservation[];
  truncated: boolean;
  driver: string;
}

export async function interpretFile(input: InterpretFileInput): Promise<InterpretFileOutput> {
  const max = config.GEMINI_MAX_INPUT_CHARS;
  const truncated = input.text.length > max;
  const fileText = truncated
    ? `${input.text.slice(0, max)}\n…\n[TRUNCATED: ${input.text.length - max} chars omitted]`
    : input.text;

  const result = await runPreset({
    key: 'drive.file_extraction.v1',
    responseSchema: perFileResponseSchema(),
    variables: {
      account_name: input.accountName ?? '(unknown)',
      campaign_name: input.campaignName ?? '(n/a)',
      known_campaigns_json: JSON.stringify(input.knownCampaigns ?? [], null, 2),
      file_path: input.file.path,
      modified_time: input.file.modifiedTime ?? '(unknown)',
      modified_by: input.file.modifiedByEmail ?? '(unknown)',
      file_text: fileText,
    },
  });

  try {
    const parsed = parseLlmJson<unknown>(result.text);
    const validated = PerFileResponseSchema.parse(parsed);
    return {
      account: validated.account,
      campaign: validated.campaign,
      truncated,
      driver: result.driver,
    };
  } catch (err) {
    logger.error(
      { err, fileId: input.file.id, raw: result.text.slice(0, 400) },
      '[drive.interpret] parse failed',
    );
    throw err;
  }
}
