/**
 * idea-matcher.ts — the "add and overwrite" brain for the ideas memory tier.
 *
 * An idea is a LIVING entity, not a per-deck snapshot. The same creative
 * concept shows up across many decks (a pitch, then refinement rounds, then a
 * creative review) under drifting names and reworded facets — BHAC's "LMA
 * Character Generator" appeared ~9 times as "Character Creator Portal",
 * "American Favorites Dealer Kit", "AI Character Web Experience"… all ONE idea.
 *
 * So before persisting a freshly-extracted idea we ask: is this the SAME idea
 * as one we already know for this account? If yes, we MERGE its facets into the
 * existing row (add new, supersede refined, dedupe) and log the change — exactly
 * how a campaign's status_markdown is synthesized forward. If no, it's a new
 * idea. Match + merge are one LLM call: judging sameness and unifying the facet
 * rows are the same act of understanding, so splitting them would only add a
 * round-trip and a chance to disagree with itself.
 *
 * Candidates are referenced by 1-based INDEX, never by echoing a uuid — the
 * model can't mangle an integer the way it can a 36-char id. Index 0 = "new".
 */

import { z } from 'zod';
import { SchemaType, type ResponseSchema } from '../ai';
import { defaultLlm, parseLlmJson } from '../ai';
import { logger } from '../logger';

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;
// Thinking tokens count against this (see the gemini-3.5-flash memory). A merge
// can re-emit a dozen facet rows; keep generous so the JSON never truncates.
const MAX_OUTPUT_TOKENS = 16384;

// Bound the prompt as an account's memory grows. We hand the model the most
// recent N ideas as match candidates; older ideas are unlikely re-pitches and
// keeping the prompt small keeps the judgment sharp. Callers that exceed this
// should pre-filter (token overlap) to the plausible candidates first — not
// needed yet at current account sizes.
const MAX_CANDIDATES = 50;

export interface KnownIdea {
  id: string;
  name: string;
  facets: string[];
}

export interface NewIdea {
  name: string;
  facets: string[];
}

export interface MatchMergeResult {
  /** The existing idea this is the same as, or null if it's a new idea. */
  matchId: string | null;
  /**
   * When matchId is set: the unified facet set to OVERWRITE the matched idea
   * with (existing ∪ new, refined rows superseded, deduped). When null: the
   * new idea's cleaned facets, unchanged.
   */
  mergedFacets: string[];
}

const ResponseSchemaZ = z.object({
  match_index: z.number().int().min(0),
  merged_facets: z.array(z.string()).default([]),
});

const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    match_index: { type: SchemaType.INTEGER },
    merged_facets: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ['match_index', 'merged_facets'],
};

function buildPrompt(args: { accountName: string | null; newIdea: NewIdea; candidates: KnownIdea[] }): string {
  const candidateBlock = args.candidates
    .map((c, i) => {
      const facets = c.facets.length ? c.facets.map((f) => `      - ${f}`).join('\n') : '      (no facets yet)';
      return `[${i + 1}] ${c.name}\n${facets}`;
    })
    .join('\n\n');

  return `You maintain an agency's institutional memory of PITCH IDEAS for one account. The same creative idea recurs across many decks — a pitch, refinement rounds, a creative review — under drifting names and reworded facets. Your job: decide whether a newly-extracted idea is the SAME idea as one already on file, and if so, merge them.

ACCOUNT: ${args.accountName ?? '(unknown)'}

NEWLY EXTRACTED IDEA:
  ${args.newIdea.name}
${args.newIdea.facets.map((f) => `    - ${f}`).join('\n') || '    (no facets)'}

IDEAS ALREADY ON FILE FOR THIS ACCOUNT:
${candidateBlock || '  (none yet)'}

STEP 1 — SAME IDEA?
Return the INDEX (the [n]) of the on-file idea that is the SAME underlying creative concept as the new one — the same core device / territory / mechanic — even if the name differs, the wording differs, or it is a later refinement round. If none is the same idea, return 0.
  - SAME: "LMA Character Generator" vs "AI Character Web Experience" vs "American Favorites Dealer Kit" when all describe one AI tool that generates local dealer characters. Renames and reworded rounds of one concept are the same idea.
  - NOT SAME: two genuinely distinct concepts that merely share a campaign, a theme, or a season. When unsure, prefer 0 (a wrong merge silently destroys a real idea; a missed merge only leaves a duplicate we can catch later).

STEP 2 — MERGE (only if match_index > 0)
Produce merged_facets = the unified facet set to REPLACE the matched idea's facets:
  - Keep every distinct facet from BOTH the on-file idea and the new one.
  - Where a new facet REFINES or EXPANDS an on-file one (more outputs, a sharper mechanic, an added platform), keep the fuller/newer row and DROP the stale one it supersedes — do not keep both.
  - Deduplicate rows that say the same thing.
  - Keep each row right-sized (the words that carry its meaning) — do not pad to prose, do not compress to a bare keyword.
  - This is the on-file idea moving FORWARD; preserve what's still true, absorb what's new.
If match_index = 0, set merged_facets to the new idea's facets unchanged.`;
}

/**
 * Decide whether `newIdea` is the same as an existing account idea and, if so,
 * how its facets merge. One LLM call. Returns matchId=null for a genuinely new
 * idea (mergedFacets = its own facets). Throws on LLM/parse failure so the
 * caller can log + fall back to a plain create.
 */
export async function matchAndMergeIdea(args: {
  newIdea: NewIdea;
  existingIdeas: KnownIdea[];
  accountName: string | null;
}): Promise<MatchMergeResult> {
  // Nothing to match against — it's the first idea of its kind. Skip the call.
  if (args.existingIdeas.length === 0) {
    return { matchId: null, mergedFacets: args.newIdea.facets };
  }

  // Most-recent-first, capped — the freshest ideas are the likeliest re-pitch.
  const candidates = args.existingIdeas.slice(-MAX_CANDIDATES);

  const completion = await defaultLlm.complete({
    model: MODEL,
    temperature: TEMPERATURE,
    prompt: buildPrompt({ accountName: args.accountName, newIdea: args.newIdea, candidates }),
    tag: 'drive.idea_match_merge.v1',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  let parsed: z.infer<typeof ResponseSchemaZ>;
  try {
    parsed = ResponseSchemaZ.parse(parseLlmJson<unknown>(completion.text));
  } catch (err) {
    logger.error({ err, raw: completion.text.slice(0, 400) }, '[drive.idea-matcher] parse failed');
    throw err;
  }

  // Guard the index: out of range → treat as no match (create) rather than
  // crash. A hallucinated high index shouldn't merge into the wrong idea.
  const idx = parsed.match_index;
  if (idx <= 0 || idx > candidates.length) {
    return { matchId: null, mergedFacets: args.newIdea.facets };
  }

  const matched = candidates[idx - 1];
  const mergedFacets = parsed.merged_facets.map((f) => f.trim()).filter(Boolean);
  // Defensive: an empty merge would blank the idea. Never let a merge delete
  // everything — fall back to the union if the model returned nothing usable.
  const safeFacets = mergedFacets.length > 0 ? mergedFacets : dedupeUnion(matched.facets, args.newIdea.facets);

  return { matchId: matched.id, mergedFacets: safeFacets };
}

function dedupeUnion(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...a, ...b]) {
    const key = f.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(f.trim());
  }
  return out;
}
