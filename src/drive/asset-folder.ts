/**
 * asset-folder.ts — name-only interpretation of binaries-only folders.
 *
 * Folders holding nothing but binary assets (fonts, images, video, design
 * files) never reach the per-file extraction prompt: extractText skips
 * every file on mime, so neither the location-context observation nor the
 * asset facts ("the brand typeface is Louis") ever fire for them. This
 * module covers that gap with ONE small LLM call per such folder, judging
 * from the only evidence available — the folder path and the file names.
 *
 * Meaning-based: the model decides whether the folder is a meaningful
 * collection; non-collections (working scraps, raw exports) return empty.
 * Routing is NOT decided here — the caller already knows the folder's
 * zone/attribution and buckets the observations deterministically.
 */

import { z } from 'zod';
import { SchemaType, type ResponseSchema } from '../ai';
import { defaultLlm } from '../ai';
import { parseLlmJson } from '../ai/prompt-preset.service';

const MODEL = 'gemini-3.5-flash';
// Thinking tokens count against this cap (see cluster-detector) — keep generous.
const MAX_OUTPUT_TOKENS = 16384;
/** Names are cheap but unbounded folders exist (photo dumps); cap the listing. */
const MAX_FILE_NAMES = 120;

export interface AssetFolderObservation {
  text: string;
  reasoning: string;
  confidence: number;
}

export interface InterpretAssetFolderInput {
  accountName: string | null;
  /** The campaign owning this folder's zone, or null in account space. */
  campaignName: string | null;
  /** Breadcrumb path of the folder, e.g. "Chevy / Brand Assets / Fonts". */
  folderPath: string;
  fileNames: string[];
}

export interface InterpretAssetFolderOutput {
  observations: AssetFolderObservation[];
  driver: string;
}

const ResponseSchemaZ = z.object({
  observations: z
    .array(
      z.object({
        text: z.string(),
        reasoning: z.string(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
});

const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    observations: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          text: { type: SchemaType.STRING },
          reasoning: { type: SchemaType.STRING },
          confidence: { type: SchemaType.NUMBER },
        },
        required: ['text', 'reasoning', 'confidence'],
      },
    },
  },
  required: ['observations'],
};

function buildPrompt(input: InterpretAssetFolderInput): string {
  const shown = input.fileNames.slice(0, MAX_FILE_NAMES);
  const omitted = input.fileNames.length - shown.length;
  const listing =
    shown.map((n) => `  - ${n}`).join('\n') +
    (omitted > 0 ? `\n  … (+${omitted} more files)` : '');

  return `You are looking at one folder from a client's shared Google Drive at an ad agency. Every file in it is a binary asset (fonts, images, video, design files) — there is no readable text, so the folder path and the file names are your only evidence.

ACCOUNT (the client): ${input.accountName ?? '(unknown)'}
CAMPAIGN (owns this folder): ${input.campaignName ?? '(n/a — account space)'}
FOLDER: ${input.folderPath}
FILES (${input.fileNames.length}):
${listing}

If this folder is a meaningful asset collection — Fonts, Logos, Brand Assets, Photography, Visual Identity, Finals, Toolkits, and the like — emit observations:
  - One locating it: name the folder by its full path, phrased as a fact about the entity ("Chevy's brand fonts live at Chevy / Brand Assets / Fonts"). Use the path verbatim — do not guess or abbreviate.
  - One per concrete asset the names reveal: a typeface, a logo variant or lockup, a photography style ("Chevy's brand typeface is Louis", from Louis-Bold.ttf). Only assets the names actually establish — don't stretch ambiguous names.

Each observation: text (one sentence, specific), reasoning (one sentence citing the evidence), confidence (0.0–1.0, your subjective certainty).

If the folder is NOT a meaningful collection (working scraps, raw exports, miscellaneous dumps, temp files), return an empty observations array.`;
}

export async function interpretAssetFolder(
  input: InterpretAssetFolderInput,
): Promise<InterpretAssetFolderOutput> {
  const completion = await defaultLlm.complete({
    model: MODEL,
    temperature: 0,
    prompt: buildPrompt(input),
    tag: 'drive.asset_folder.v1',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const parsed = ResponseSchemaZ.parse(parseLlmJson(completion.text));
  return { observations: parsed.observations, driver: completion.driver };
}
