/**
 * extract-vision.ts — Gemini document-understanding ("vision") extraction
 * for PDFs (issue C1 / #34) and piece-scoped images (issue C2 / #35).
 *
 * The text-layer parser (unpdf) reads only the PDF's embedded text: it
 * loses layout, charts, and everything in image-set decks (a designed
 * pitch deck exported to PDF often carries most of its content as
 * rendered artwork). Gemini multimodal reads the rendered pages, so it
 * transcribes visual decks the text layer can't.
 *
 * Contract (verified against the document-understanding docs, 2026-08):
 *   - gemini-3.5-flash accepts PDFs as inlineData parts on
 *     generateContent; the TOTAL request is capped at 20 MB and 1000
 *     pages; each page costs ~258 image tokens on top of native text.
 *   - Only PDF gets this treatment. PPTX is NOT an accepted document
 *     mime for inline understanding — decks benefit when they are PDF
 *     exports (the common agency case). Google Slides stays on the
 *     native Slides API (structured text beats OCR; see extract.ts).
 *
 * Failure posture (PDF): a vision failure must NEVER fail the scan or
 * drop a file. Every gate and error here returns null, and extract.ts
 * falls back to the text-layer path. There is no `vision_failed` skip
 * reason by design — vision failing is a downgrade, not a skip.
 *
 * Failure posture (image, C2): images have NO text fallback, so the image
 * path is not skip-neutral the way the PDF path is. A gate-off returns
 * the pre-C2 unsupported_mime skip (dark launch stays a no-op), a vision
 * error returns a detail-tagged unsupported_mime skip (the file still
 * feeds the name-only asset-folder path), and an empty transcription
 * becomes the ordinary `empty` skip. Nothing here ever throws or fails
 * the scan.
 *
 * Output contract: the SAME flat marked-up text the Google-native
 * walkers emit (`# Title`, `## <section>` markers, tab-separated table
 * rows) so downstream interpret.ts consumes it unchanged. The full
 * marker grammar — including `## Page N` as the PDF-side equivalent of
 * `## Slide N`, and `[bracketed]` one-line visual descriptions — lives
 * in extract-markers.ts (issue C3 / #36); the contract test pins that
 * vision-shaped output satisfies it. Keep the prompts below and that
 * grammar in lockstep.
 */

import { config } from '../config';
import { logger } from '../logger';
import { defaultLlm, DEFAULT_GEMINI_MODEL } from '../ai';
import type { LlmUsage } from '../ai';
import type { ExtractionSkip, TraversedFile } from './types';

/**
 * Mirrors the walkers' marker contract: `#` title, `##` per-page
 * sections, tab-separated tables — flat text throughout. Bracketed
 * one-line descriptions surface chart/image content that a text-layer
 * extraction would silently drop.
 */
const VISION_PROMPT = `You are a document transcription engine. Transcribe the attached PDF into flat, structured plain text.

Rules:
- If a document title is evident, emit "# <title>" as the first line.
- For each page emit a "## Page N" heading, then that page's content in natural reading order.
- Preserve headings, paragraphs, and lists as plain text lines.
- Render tables as tab-separated cells, one row per line.
- For charts, diagrams, and meaningful images, add a one-line description in square brackets, e.g. [Chart: monthly revenue by region, peaks in March].
- Transcribe ALL legible text, but emit boilerplate that recurs on every page (confidentiality footers, page numbers) at most once.
- Output the transcription only — no preamble, no commentary, no code fences.`;

export interface VisionExtractionResult {
  text: string;
  model: string;
  usage?: LlmUsage;
}

/**
 * Count pages via the text-layer parser. Returns null when the parser
 * can't open the file — which deliberately does NOT disqualify vision:
 * scanned/exotic PDFs that unpdf chokes on are exactly where vision can
 * still succeed (the 1000-page API limit backstops us; an over-limit
 * request errors and falls back like any other vision failure).
 */
export async function countPdfPages(buf: Buffer): Promise<number | null> {
  try {
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
    return pdf.numPages;
  } catch {
    return null;
  }
}

/**
 * The raw vision call — no gating, throws on error. Exposed separately
 * so the eval script can measure it (latency + token usage) without the
 * fallback semantics swallowing failures.
 */
export async function visionExtractPdf(buf: Buffer): Promise<VisionExtractionResult> {
  const model = config.DRIVE_VISION_MODEL || DEFAULT_GEMINI_MODEL;
  const result = await defaultLlm.complete({
    model,
    temperature: 0,
    prompt: VISION_PROMPT,
    media: [{ mimeType: 'application/pdf', dataBase64: buf.toString('base64') }],
    maxOutputTokens: config.DRIVE_VISION_MAX_OUTPUT_TOKENS,
    // Transcription doesn't need reasoning; thinking tokens count
    // against maxOutputTokens AND add latency. Bump if quality suffers.
    thinkingLevel: 'MINIMAL',
    timeoutMs: config.DRIVE_VISION_TIMEOUT_MS,
    tag: 'drive.vision_extraction.v1',
  });
  return { text: result.text.trim(), model, ...(result.usage ? { usage: result.usage } : {}) };
}

/**
 * Vision extraction with all gates applied. Returns the transcribed
 * text, or null for "use the text-layer path instead" — on gating
 * (disabled, mock driver, size/page caps) and on ANY error, including
 * an empty transcription (anomalous for a non-empty PDF; the text layer
 * decides whether the file is genuinely empty).
 */
export async function tryVisionPdfExtraction(
  file: Pick<TraversedFile, 'id' | 'name'>,
  buf: Buffer,
): Promise<string | null> {
  if (!config.DRIVE_VISION_ENABLED) return null;
  // The mock driver returns a schema-shaped stub, not a transcription —
  // storing it as extracted text would poison the pipeline in dev.
  if (defaultLlm.name === 'mock') return null;
  if (buf.length > config.DRIVE_VISION_MAX_FILE_SIZE_BYTES) {
    logger.debug(
      { fileId: file.id, name: file.name, sizeBytes: buf.length },
      '[drive.vision] over vision size cap — using text-layer path',
    );
    return null;
  }
  const pageCount = await countPdfPages(buf);
  if (pageCount !== null && pageCount > config.DRIVE_VISION_MAX_PDF_PAGES) {
    logger.debug(
      { fileId: file.id, name: file.name, pageCount },
      '[drive.vision] over vision page cap — using text-layer path',
    );
    return null;
  }

  try {
    const { text } = await visionExtractPdf(buf);
    if (!text) {
      logger.warn(
        { fileId: file.id, name: file.name, pageCount },
        '[drive.vision] vision_failed: empty transcription — falling back to text-layer path',
      );
      return null;
    }
    return text;
  } catch (err) {
    // Transient faults were already retried inside the LLM driver.
    logger.warn(
      { err, fileId: file.id, name: file.name, sizeBytes: buf.length, pageCount },
      '[drive.vision] vision_failed — falling back to text-layer path',
    );
    return null;
  }
}

// ── Image extraction (issue C2 / #35) ───────────────────────────────────────

/**
 * Same marker contract as VISION_PROMPT (`#` title, bracketed one-line
 * visual descriptions, flat text) so interpret.ts consumes image output
 * unchanged. In an agency Drive the image often IS the deliverable — key
 * visual, poster, mockup — so beyond legible text we ask for the brand /
 * creative content a name-only pass would miss. Chrome (icons, UI
 * fragments) transcribes to nothing → the ordinary `empty` skip; that
 * emptiness is the implicit relevance backstop behind the metadata floor.
 */
const VISION_IMAGE_PROMPT = `You are a creative-asset transcription engine. Transcribe the attached image into flat, structured plain text for a marketing-intelligence pipeline.

Rules:
- If the image carries an evident title or headline, emit "# <headline>" as the first line.
- Transcribe ALL legible text in natural reading order: headlines, body copy, captions, calls to action, disclaimers.
- Add a one-line description of the visual in square brackets, e.g. [Poster: product bottle on a yellow field, bold retro typography].
- Note identifiable brand and creative elements (logos, product shots, taglines, recurring campaign motifs) as plain text lines.
- If the image is pure interface chrome, an icon, or a decorative fragment with no marketing or creative content, output nothing at all.
- Output the transcription only — no preamble, no commentary, no code fences.`;

/**
 * Synchronous runtime gate for the image path, shared by extractText AND
 * predictExtractionSkip so the two stay in lockstep: while this is false,
 * every image/* file skips exactly as it did before C2 (unsupported_mime).
 * The mock-driver check mirrors the PDF gate — a schema-shaped stub must
 * not be stored as extracted text in dev.
 */
export function imageVisionRuntimeAvailable(): boolean {
  return config.DRIVE_IMAGE_VISION_ENABLED && defaultLlm.name !== 'mock';
}

/**
 * The raw image vision call — no gating, throws on error. Exposed
 * separately (like visionExtractPdf) so an eval script can measure it
 * without the skip semantics swallowing failures.
 */
export async function visionExtractImage(
  mimeType: string,
  buf: Buffer,
): Promise<VisionExtractionResult> {
  const model = config.DRIVE_VISION_MODEL || DEFAULT_GEMINI_MODEL;
  const result = await defaultLlm.complete({
    model,
    temperature: 0,
    prompt: VISION_IMAGE_PROMPT,
    media: [{ mimeType, dataBase64: buf.toString('base64') }],
    maxOutputTokens: config.DRIVE_VISION_MAX_OUTPUT_TOKENS,
    // Same rationale as the PDF call: transcription doesn't need
    // reasoning, and thinking tokens count against maxOutputTokens.
    thinkingLevel: 'MINIMAL',
    timeoutMs: config.DRIVE_VISION_TIMEOUT_MS,
    tag: 'drive.image_vision_extraction.v1',
  });
  return { text: result.text.trim(), model, ...(result.usage ? { usage: result.usage } : {}) };
}

/**
 * Image vision with the runtime gates applied. Returns the transcription
 * text on success (possibly empty — extract.ts's ok() turns that into the
 * ordinary `empty` skip), or an ExtractionSkip on any gate or failure.
 * NEVER throws: images have no text fallback, so a vision problem must be
 * a skip, not a scan failure. Scope/cap/relevance gating happened in the
 * caller (the scan worker) before the bytes were ever downloaded — this
 * function only enforces the gates that need the actual bytes or the
 * runtime environment.
 */
export async function tryVisionImageExtraction(
  file: Pick<TraversedFile, 'id' | 'name' | 'mimeType'>,
  buf: Buffer,
): Promise<string | ExtractionSkip> {
  // Gate-off → the EXACT skip images produced before C2, so the dark
  // launch (flag off) and dev (mock driver) are behavior no-ops.
  if (!imageVisionRuntimeAvailable()) {
    return { kind: 'skip', reason: 'unsupported_mime', detail: file.mimeType };
  }
  // Actual-byte cap (predict checked Drive's size metadata; this is the
  // authoritative check on what we really downloaded).
  if (buf.length > config.DRIVE_IMAGE_MAX_FILE_SIZE_BYTES) {
    logger.debug(
      { fileId: file.id, name: file.name, sizeBytes: buf.length },
      '[drive.vision] image over vision size cap — skipping (no fallback)',
    );
    return {
      kind: 'skip',
      reason: 'out_of_scope_image',
      detail: `over_size_cap size=${buf.length} limit=${config.DRIVE_IMAGE_MAX_FILE_SIZE_BYTES}`,
    };
  }

  try {
    const { text } = await visionExtractImage(file.mimeType, buf);
    return text;
  } catch (err) {
    // Transient faults were already retried inside the LLM driver. The
    // detail-tagged unsupported_mime keeps the file on the name-only
    // asset-folder path — the filename still contributes evidence.
    logger.warn(
      { err, fileId: file.id, name: file.name, sizeBytes: buf.length, mimeType: file.mimeType },
      '[drive.vision] image_vision_failed — skipping (images have no text fallback)',
    );
    return {
      kind: 'skip',
      reason: 'unsupported_mime',
      detail: `image_vision_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
