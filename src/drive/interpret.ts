/**
 * drive.interpret.ts — Per-file Gemini call (preset: drive.file_extraction.v1).
 *
 * Sends file text + current state of both the parent account AND the current
 * campaign to Gemini, and receives back a schema-enforced response of the
 * shape: { account: Observation[], campaign: Observation[] }.
 *
 * Gemini decides — per entity — whether the file content implies a change
 * vs current state; when it doesn't, the corresponding array is empty.
 *
 * Callers (the orchestrator) accumulate these two buckets across a scan and
 * hand each to drive.distill for per-entity dedupe + proposal emission.
 */

import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { parseLlmJson, runPreset } from '../ai';
import {
  ACCOUNT_WRITABLE_FIELDS,
  CAMPAIGN_WRITABLE_FIELDS,
  type AccountCurrentState,
  type CampaignCurrentState,
} from './schema';
import { perFileResponseSchema } from './structured-output';
import type { TraversedFile } from './types';

// ── Response shape (schema-enforced by Gemini; Zod revalidates) ─────────────

const AccountObservationSchema = z.object({
  kind: z.enum(['field_change', 'note']),
  field: z.enum(ACCOUNT_WRITABLE_FIELDS).nullable().optional(),
  proposed_value: z.string().nullable().optional(),
  note_text: z.string().nullable().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const CampaignObservationSchema = z.object({
  kind: z.enum(['field_change', 'note']),
  field: z.enum(CAMPAIGN_WRITABLE_FIELDS).nullable().optional(),
  proposed_value: z.string().nullable().optional(),
  note_text: z.string().nullable().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const PerFileResponseSchema = z.object({
  account: z.array(AccountObservationSchema).default([]),
  campaign: z.array(CampaignObservationSchema).default([]),
});

export type AccountObservation = z.infer<typeof AccountObservationSchema>;
export type CampaignObservation = z.infer<typeof CampaignObservationSchema>;

/** Enriched with the source file id once the orchestrator receives it. */
export interface SourcedObservation<T> {
  observation: T;
  sourceFileId: string;
}

export interface InterpretFileInput {
  file: TraversedFile;
  text: string;
  accountName: string | null;
  accountCurrentState: AccountCurrentState;
  campaignName: string | null;
  campaignCurrentState: CampaignCurrentState | null;
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
      account_current_state_json: JSON.stringify(input.accountCurrentState, null, 2),
      campaign_name: input.campaignName ?? '(n/a)',
      campaign_current_state_json: input.campaignCurrentState
        ? JSON.stringify(input.campaignCurrentState, null, 2)
        : '(no campaign in scope)',
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
