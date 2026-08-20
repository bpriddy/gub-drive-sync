# `drive.file_extraction.v1` — vision-awareness update (C3 / #36)

**Status: NOT applied by this repo.** The interpret prompt is a staff-edited row in
`prompt_presets` (per D15 — see `docs/status-markdown-plan.md` and `status-synthesis.ts`), so
there is deliberately no seed here. A human applies this edit via the prompt-authoring path
(gub-admin → prompt presets → `drive.file_extraction.v1`). **Keep the key `v1`** — edit the
template in place; changing the key would require an `interpret.ts` code change.

## Why

C1/C2 made extraction vision-rich: PDFs and piece-scoped images are transcribed by Gemini and
arrive as `## Page N` sections with `[bracketed]` one-line descriptions of charts, posters, and
creative visuals (see `src/drive/extract-markers.ts` — the marker grammar's single source of
truth). The interpret prompt was written for flat native text and doesn't acknowledge those
tokens, so vision's differentiating signal can be discarded as formatting noise. This edit
teaches the prompt that the markers are structure and the bracketed lines are content.

## The edit

Insert the following block into the template **between the `Contents:` `"""` block and the
`TASK` section** (match the template's two-space indent):

```
  NOTE ON CONTENTS — the text above is machine-extracted (Workspace API
  walkers for Google-native files; Gemini vision transcription for PDFs
  and images). It may contain structural markers:
    - "# <title>" — the document/deck/workbook title (or an image's headline)
    - "## Page N" / "## Slide N" / "## Sheet: <name>" — EQUIVALENT section
      boundaries: which one appears depends only on the file type (a PDF's
      pages are a deck's slides). Treat them identically.
    - "### Speaker notes" — a slide's speaker notes
    - tab-separated table rows
    - one-line [bracketed] descriptions of charts, diagrams, images, and
      creative visuals, e.g. [Chart: monthly revenue by region, peaks in
      March] or [Poster: product bottle on a yellow field, bold retro
      typography]
  [Bracketed] lines are OBSERVED CONTENT — what the extractor saw on the
  rendered page — not formatting noise. Mine them for substance exactly like
  the surrounding text: a chart's stated trend can be a status or budget
  signal, a described poster or key visual can reveal a campaign's creative
  concept, positioning, or brand assets. A bracketed visual description
  passes the POSITIVE TEST below the same way the equivalent sentence of
  body copy would — judge it by what it says about THIS client's work.
```

Nothing else in the template changes: the agency filter, positive test, routing rules, deck-type
classification, and output shape all stay as they are. The response schema is code
(`structured-output.ts`) and is not touched by C3.

The full updated template (current row + this block) is in the C3 PR body for copy-paste. The
authoritative current text is always the DB row — if staff edited it after this note was
written, re-anchor the block on the `Contents`/`TASK` boundary rather than pasting the PR's
full text over their edits.

## After applying — manual dev spot-check

Vision-heavy behavior can't be unit-tested from this repo (the prompt is the DB row; the mock
driver is gated off vision). After applying:

1. Run a scan over a vision-heavy file (an image-set pitch deck exported to PDF, or an
   in-scope piece image) with real Gemini credentials.
2. Confirm bracketed content flows into observations — e.g. a `[Poster: …]` line surfacing as
   a creative-concept/brand-asset observation, a `[Chart: …]` trend surfacing as a status or
   budget signal.
3. Spot-check a couple of plain-text files for unchanged behavior (no new noise observations).
