/**
 * extract-markers.ts — the extraction-text marker grammar (issue C3 / #36).
 *
 * Single source of truth for what extraction text may contain, shared by:
 *   - the PRODUCERS — extract.ts walkers and extract-vision.ts prompts
 *     (their header docs point here; the contract test pins conformance)
 *   - the CONSUMERS — idea-extraction.ts embeds MARKER_GRAMMAR_PROMPT_NOTE
 *     in its in-code prompt; the drive.file_extraction.v1 DB prompt row
 *     mirrors the same note (delivered via the staff prompt-authoring
 *     path — per D15 that prompt is deliberately NOT code-seeded)
 *   - the CONTRACT TEST — __tests__/interpret-contract.test.ts checks that
 *     native-walker output and vision-shaped output both satisfy this
 *     grammar, so producer drift breaks a test instead of silently
 *     degrading the consumers
 *
 * The grammar (one marker per line; flat plain text everywhere else):
 *   "# <title>"          — document/deck/workbook title, or an image's headline
 *   "## Page N"          — vision PDF page           ┐ EQUIVALENT section
 *   "## Slide N"         — native Slides slide       ├ boundaries — a PDF's
 *   "## Sheet: <name>"   — native Sheets tab         ┘ pages are a deck's slides
 *   "### Speaker notes"  — a slide's speaker-notes section
 *   tab-separated cells  — table rows, one row per line
 *   "[<one-line description>]" — vision's description of a chart, diagram,
 *     poster, or creative image. OBSERVED CONTENT, not formatting noise.
 *
 * The Page/Slide/Sheet divergence is reconciled HERE and in the consumers,
 * never in the extractors: a PDF genuinely has pages, so the extractor must
 * not fake slide numbers on it. Keep this module behavior-free — regexes and
 * prompt text only; the extractors do not consult it at runtime.
 */

/** "# <title>" — first line of most extractions; also an image's headline. */
export const TITLE_MARKER = /^# \S.*$/;

/**
 * "## Page N" | "## Slide N" | "## Sheet: <name>" — the three EQUIVALENT
 * section boundaries. Which one appears depends only on the extractor that
 * produced the text, not on the content's meaning.
 */
export const SECTION_MARKER = /^## (?:Page \d+|Slide \d+|Sheet: \S.*)$/;

/** "### Speaker notes" — the only three-hash marker the grammar allows. */
export const SPEAKER_NOTES_MARKER = /^### Speaker notes$/;

/** "[<one-line visual/creative description>]" — a whole-line bracketed note. */
export const VISUAL_DESCRIPTION_MARKER = /^\[.+\]$/;

/**
 * Prompt-ready description of the grammar for the consumer prompts.
 * idea-extraction.ts embeds this verbatim; the drive.file_extraction.v1
 * DB row carries a matching note (see the C3 PR body / docs note).
 */
export const MARKER_GRAMMAR_PROMPT_NOTE = `It is machine-extracted (Workspace API walkers for Google-native files; Gemini vision transcription for PDFs and images) and may contain structural markers: "# <title>"; "## Page N" / "## Slide N" / "## Sheet: <name>" — EQUIVALENT section boundaries (a PDF's pages are a deck's slides; treat them identically); "### Speaker notes"; tab-separated table rows; and one-line [bracketed] descriptions of charts, diagrams, and creative visuals, e.g. [Chart: monthly revenue by region, peaks in March] or [Poster: product bottle on a yellow field, bold retro typography]. Bracketed lines are OBSERVED CONTENT — what the extractor saw on the rendered page — not formatting noise.`;

/**
 * Return the marker-SHAPED lines that don't conform to the grammar: any
 * "## " line that isn't one of the three section boundaries, and any
 * "### " line that isn't the speaker-notes marker. Plain content lines
 * (including "# <title>" — any text is a valid title) never violate.
 * Test-only helper; production code never validates extraction text.
 */
export function findMarkerGrammarViolations(text: string): string[] {
  const violations: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('### ')) {
      if (!SPEAKER_NOTES_MARKER.test(line)) violations.push(line);
    } else if (line.startsWith('## ')) {
      if (!SECTION_MARKER.test(line)) violations.push(line);
    }
  }
  return violations;
}
