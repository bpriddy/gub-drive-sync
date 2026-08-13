/**
 * idea-extraction.ts — #3 of the "leaf size" work: derive `ideas` (the
 * institutional-memory tier) from pitch decks and creative review decks.
 *
 * Runs PER FILE, alongside interpret.ts (which stays a pure observation
 * extractor — we don't bloat it). This is a separate, focused call because
 * carving N ideas out of a deck + right-sizing their facet rows is a
 * different, meatier job than "what does this file reveal about the account".
 *
 * TIGHTLY GATED — an idea is a thing PRESENTED AS an idea in one of exactly
 * two artifact types, and nowhere else:
 *   - a PITCH DECK        (concepts proposed to win/answer a brief), or
 *   - a CREATIVE REVIEW DECK (creative presented for feedback/approval).
 * Everything else — briefs, strategy/planning decks, media plans, status/wrap
 * decks, final delivered creative, capabilities/credentials, SOPs — is `other`
 * and yields NO ideas. We do not *infer* ideas from strategy, background, or
 * execution notes; we only capture what the deck itself frames as a creative
 * idea/concept/territory/route. If `deck_type` is `other`, ideas are dropped
 * even if the model emitted some — the gate wins.
 *
 * Conservative by design (same discipline as the structure classifier and the
 * dedup): when a file isn't clearly one of the two idea decks, emit nothing
 * rather than fabricate. Persistence + external-id wiring is the caller's job.
 */

import { z } from 'zod';
import { SchemaType, type ResponseSchema } from '../ai';
import { defaultLlm, parseLlmJson, DEFAULT_GEMINI_MODEL } from '../ai';
import { logger } from '../logger';
import type { TraversedFile } from './types';

const MODEL = DEFAULT_GEMINI_MODEL;
const TEMPERATURE = 0.2;
// Generous on purpose: gemini-3.5-flash thinking tokens count against this,
// and a dense deck can emit several ideas with many facet rows. Too low a cap
// truncates the JSON → parse failure → the file silently yields no ideas.
const MAX_OUTPUT_TOKENS = 16384;

export type DeckType = 'pitch' | 'creative_review' | 'other';

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
  /** 'pitch' | 'creative_review' → an idea source; 'other' → yields no ideas. */
  deckType: DeckType;
  ideas: ExtractedIdea[];
}

const ResponseSchemaZ = z.object({
  deck_type: z.enum(['pitch', 'creative_review', 'other']),
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
    deck_type: { type: SchemaType.STRING, enum: ['pitch', 'creative_review', 'other'], format: 'enum' },
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
  required: ['deck_type', 'ideas'],
};

function buildPrompt(args: {
  accountName: string | null;
  filePath: string;
  fileName: string;
  fileText: string;
}): string {
  return `You are mining an agency's Google Drive for PITCH IDEAS — creative concepts the agency proposed. These become institutional memory ("have we already pitched something like this?"), so precision matters more than recall: a wrong idea pollutes the memory.

ACCOUNT: ${args.accountName ?? '(unknown)'}
FILE NAME: ${args.fileName}
FOLDER PATH: ${args.filePath}

FILE CONTENT:
"""
${args.fileText}
"""

STEP 1 — WHAT KIND OF DECK IS THIS?  (deck_type)
Ideas live in exactly TWO kinds of artifact, and NOWHERE else:
  - "pitch"           — a PITCH DECK: creative concepts proposed to win or answer a brief (new business, an RFP response, a concept round against a client brief).
  - "creative_review" — a CREATIVE REVIEW DECK: creative work/concepts presented internally or to the client for feedback or approval during development.

Everything else is "other" → deck_type="other" and ideas=[]. Explicitly NOT idea sources:
  briefs / RFPs that only state the ASK, strategy or planning decks, media plans, timelines, budgets, status / wrap / recap decks, final delivered creative, case studies, capabilities / credentials decks, SOPs, agency-internal material.

Weight the FILE NAME and FOLDER PATH heavily — agency naming is dense with intent ("Pitch", "Concepts", "Round 1/2", "Creative Review", "Territories", "R&D") — but CONFIRM with the content; filenames lie. If the deck does not actually PRESENT proposed creative ideas for a decision, it is "other".

STEP 2 — EXTRACT IDEAS  (only when deck_type is "pitch" or "creative_review")
Extract ONLY things the deck itself PRESENTS AS an idea — a named creative concept, territory, route, or an explicit "here's our idea." These are the distinct creative directions the deck frames as ideas.
Do NOT infer ideas from: the brief, the strategy, the insight, the background, the media plan, or execution/production notes. If it isn't presented as a creative idea, it is not one.
An idea is ONE discrete concept. Never emit the campaign's overall platform, approach, or creative direction as an idea — "the illustration-led storytelling platform" is the campaign itself, not an idea. When a deck presents an umbrella with distinct concepts inside it, extract the concepts, not the umbrella.

For each idea:
  - name: the idea's handle/title as the deck calls it (verbatim when it has one; a short faithful label otherwise).
  - facets: RIGHT-SIZED natural-language rows — one per axis the idea activates (tone, format/mechanic, platform/channel, cultural or seasonal hook, memes/references, casting, the core creative device). Good rows:
      "tongue in cheek"
      "social-first campaign"
      "leverages the current World Cup"
      "adopts the 'I am Spartacus' meme format"
      "hook is a blond ponytail wig riffing on Haaland"
    Each row keeps the words that carry its meaning — do NOT pad to prose, do NOT compress to a bare keyword. The facet rows together ARE the idea's description.

RULES
  - The gate is strict: if it isn't clearly a pitch or creative_review deck, deck_type="other" and no ideas. Better to miss than to invent.
  - One idea shown in several executions is ONE idea (the executions are facets), not several.
  - Distinct creative concepts only — not the brief's requirements, not production notes, not the media plan.`;
}

/**
 * Extract pitch ideas from a single file. Returns deckType='other' + ideas=[]
 * for non-idea-decks (the common case) — the caller skips persistence for
 * those. Throws on LLM/parse failure so the caller can log + continue.
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

  // The gate WINS: a non-idea deck yields no ideas, even if the model listed
  // some. This is the tightening — memory precision over recall.
  if (parsed.deck_type === 'other') {
    return { deckType: 'other', ideas: [] };
  }

  const ideas = parsed.ideas
    .map((i) => ({ name: i.name.trim(), facets: i.facets.map((f) => f.trim()).filter(Boolean) }))
    .filter((i) => i.name.length > 0);

  return { deckType: parsed.deck_type, ideas };
}
