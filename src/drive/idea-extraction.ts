/**
 * idea-extraction.ts — #3 of the "leaf size" work: derive `ideas` (the
 * institutional-memory tier) from pitch artifacts.
 *
 * Runs PER FILE, alongside interpret.ts (which stays a pure observation
 * extractor — we don't bloat it). This is a separate, focused call because
 * carving N ideas out of a deck + right-sizing their facet rows is a
 * different, meatier job than "what does this file reveal about the account".
 *
 * Two things happen in one call:
 *   1. GATE — is this file a pitch artifact at all? Heavily weight the file
 *      NAME and FOLDER PATH (agency filenames are dense with intent: "Pitch",
 *      "RFP", "Concepts", "Round 2", "Deck", "Brief response"), CONFIRMED by
 *      content. Status reports / media plans / wrap decks / final deliverables
 *      are NOT pitch artifacts. Non-artifact → return empty, cheaply.
 *   2. SEGMENT + FACET — a single deck usually holds MULTIPLE distinct ideas.
 *      Split them, and for each emit right-sized facet rows: full
 *      natural-language phrases capturing whatever axes the idea activates
 *      (tone, mechanic, platform, cultural hook, references…), neither padded
 *      to prose nor truncated to keywords. The facet rows ARE the idea's
 *      description.
 *
 * Conservative by design (same discipline as the structure classifier and the
 * dedup): when a file isn't clearly a pitch artifact, emit nothing rather than
 * fabricate ideas. Persistence + external-id wiring is the caller's job.
 */

import { z } from 'zod';
import { SchemaType, type ResponseSchema } from '@google/generative-ai';
import { defaultLlm, parseLlmJson } from '../ai';
import { logger } from '../logger';
import type { TraversedFile } from './types';

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.2;
// Generous on purpose: gemini-3.5-flash thinking tokens count against this,
// and a dense deck can emit several ideas with many facet rows. Too low a cap
// truncates the JSON → parse failure → the file silently yields no ideas.
const MAX_OUTPUT_TOKENS = 16384;

export interface ExtractedIdea {
  /** The idea's handle/title, verbatim-ish from the deck. */
  name: string;
  /**
   * Right-sized natural-language facet rows — the idea's description IS these.
   * e.g. "leverages the World Cup", "adopts the 'I am Spartacus' meme",
   * "hook is a blond ponytail wig riffing on Haaland".
   */
  facets: string[];
}

export interface IdeaExtractionResult {
  isPitchArtifact: boolean;
  ideas: ExtractedIdea[];
}

const ResponseSchemaZ = z.object({
  is_pitch_artifact: z.boolean(),
  ideas: z
    .array(
      z.object({
        name: z.string().min(1),
        facets: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    is_pitch_artifact: { type: SchemaType.BOOLEAN },
    ideas: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING },
          facets: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
        required: ['name', 'facets'],
      },
    },
  },
  required: ['is_pitch_artifact', 'ideas'],
};

function buildPrompt(args: {
  accountName: string | null;
  filePath: string;
  fileName: string;
  fileText: string;
}): string {
  return `You are mining an agency's Google Drive for PITCH IDEAS — the creative concepts the agency proposed to answer a brief. These become institutional memory: "have we already pitched something like this?"

ACCOUNT: ${args.accountName ?? '(unknown)'}
FILE NAME: ${args.fileName}
FOLDER PATH: ${args.filePath}

FILE CONTENT:
"""
${args.fileText}
"""

STEP 1 — IS THIS A PITCH ARTIFACT?
A pitch artifact is a deck or doc that PROPOSES creative ideas/concepts to answer a brief (a pitch deck, an RFP/brief response, a concept round, a "big idea" doc).

Weight the FILE NAME and FOLDER PATH heavily — agency naming is dense with intent: "Pitch", "RFP", "Concepts", "Ideas", "Round 1/2", "Deck", "Brief Response", "Territories". BUT confirm with the content — filenames lie ("final_v7_ACTUAL"), so the slides must actually contain proposed creative ideas.

NOT pitch artifacts (set is_pitch_artifact=false, ideas=[]): status reports, media plans, timelines, budgets, wrap/recap decks, final delivered creative, SOPs/capabilities/agency-internal decks, contact sheets, briefs that only state the ASK without proposing ideas.

If it is NOT a pitch artifact → is_pitch_artifact=false and an empty ideas array. Do not fabricate ideas from a non-pitch file.

STEP 2 — SEGMENT + FACET (only if it IS a pitch artifact)
A single deck usually contains MULTIPLE distinct ideas (an agency answers a brief with several concepts). Split them into separate ideas. For each idea:
  - name: the idea's handle/title as the deck calls it (verbatim when it has one; a short faithful label otherwise).
  - facets: a list of RIGHT-SIZED natural-language rows — one per axis the idea activates. Capture whatever the idea leans on: tone, format/mechanic, platform/channel, cultural or seasonal hook, memes/references, casting, the core creative device. Examples of good rows:
      "tongue in cheek"
      "social-first campaign"
      "leverages the current World Cup"
      "adopts the 'I am Spartacus' meme format"
      "hook is a blond ponytail wig riffing on Haaland"
    Each row keeps the words that carry its meaning — do NOT pad to prose, do NOT compress to a bare keyword. The facet rows together ARE the idea's description.

RULES
  - Conservative: if unsure whether the file is a pitch artifact, lean is_pitch_artifact=false. Better to miss than to invent.
  - Only emit ideas that are genuinely PROPOSED creative concepts — not the brief's requirements, not production notes, not the media plan.
  - Distinct ideas only: if the deck presents one idea in several executions, that's ONE idea (the executions are facets), not several.`;
}

/**
 * Extract pitch ideas from a single file. Returns {isPitchArtifact:false,
 * ideas:[]} for non-artifacts (the common case) — the caller skips persistence
 * for those. Throws on LLM/parse failure so the caller can log + continue.
 */
export async function extractIdeasFromFile(args: {
  file: TraversedFile;
  text: string;
  accountName: string | null;
}): Promise<IdeaExtractionResult> {
  const prompt = buildPrompt({
    accountName: args.accountName,
    filePath: args.file.path,
    fileName: args.file.name,
    fileText: args.text,
  });

  const completion = await defaultLlm.complete({
    model: MODEL,
    temperature: TEMPERATURE,
    prompt,
    tag: 'drive.idea_extraction.v1',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  let parsed: z.infer<typeof ResponseSchemaZ>;
  try {
    const raw = parseLlmJson<unknown>(completion.text);
    parsed = ResponseSchemaZ.parse(raw);
  } catch (err) {
    logger.error(
      { err, fileId: args.file.id, raw: completion.text.slice(0, 400) },
      '[drive.idea-extraction] parse failed',
    );
    throw err;
  }

  // Guard: even if the model set is_pitch_artifact=true, drop ideas with no
  // name; and if it emitted ideas while claiming non-artifact, trust the ideas
  // (content won over the gate).
  const ideas = parsed.ideas
    .map((i) => ({ name: i.name.trim(), facets: i.facets.map((f) => f.trim()).filter(Boolean) }))
    .filter((i) => i.name.length > 0);

  return {
    isPitchArtifact: parsed.is_pitch_artifact || ideas.length > 0,
    ideas,
  };
}
