/**
 * extract-vision.ts — Gemini document-understanding ("vision") extraction
 * for PDFs (issue C1 / #34).
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
 * Failure posture: a vision failure must NEVER fail the scan or drop a
 * file. Every gate and error here returns null, and extract.ts falls
 * back to the text-layer path. There is no `vision_failed` skip reason
 * by design — vision failing is a downgrade, not a skip.
 *
 * Output contract: the SAME flat marked-up text the Google-native
 * walkers emit (`# Title`, `## <section>` markers, tab-separated table
 * rows) so downstream interpret.ts consumes it unchanged.
 */

import { config } from '../config';
import { logger } from '../logger';
import { defaultLlm, DEFAULT_GEMINI_MODEL } from '../ai';
import type { LlmUsage } from '../ai';
import type { TraversedFile } from './types';

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
