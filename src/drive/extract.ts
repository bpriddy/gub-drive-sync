/**
 * drive.extract.ts — Text extraction dispatch.
 *
 * Given a TraversedFile, return an ExtractionOutcome:
 *   - { kind: 'ok', text, contentHash, extractor } for supported files
 *   - { kind: 'skip', reason } for folders, unsupported mime, oversized, or empty
 *
 * Skip reasons route to drive_scan_logs with the matching category.
 *
 * Extractors:
 *   Google-native (use the dedicated Workspace API for each type — NOT Drive
 *   `files.export`, which is an export/download operation subject to a
 *   separate DLP policy; see feedback_use_conventional_documented_apis.md
 *   for why we read content via the canonical per-type APIs instead):
 *     - Google Docs   → Docs API documents.get          (extractor='gdoc')
 *     - Google Slides → Slides API presentations.get    (extractor='gslides')
 *     - Google Sheets → Sheets API spreadsheets.get +
 *                        values.batchGet                 (extractor='gsheet')
 *
 *   Binary:
 *     - application/pdf → Gemini document understanding (extractor='vision'),
 *       with automatic fallback to the text-layer parser unpdf
 *       (extractor='pdf') on any vision gate or failure — see
 *       extract-vision.ts for the gates and the failure posture
 *     - application/vnd.openxmlformats-…wordprocessingml.document  → mammoth (.docx)
 *     - text/* (plaintext, markdown, csv, etc.) → direct download (extractor='plaintext')
 *     - image/* (PNG/JPEG/WEBP/HEIC/HEIF only) → Gemini image understanding
 *       (extractor='vision-image'), issue C2 / #35. Scope-gated by the
 *       CALLER via opts.allowImageVision — only the scan worker knows piece
 *       scope — and by DRIVE_IMAGE_VISION_ENABLED (default off: dark launch
 *       keeps the pre-C2 unsupported_mime behavior). Out-of-scope images
 *       skip with reason='out_of_scope_image'. Unlike PDF vision there is
 *       NO text fallback: vision gates/failures are skips, never throws.
 *
 *   Anything else → skip with reason='unsupported_mime'.
 *
 * Each Google-native walker produces structured-but-flat text with section
 * markers (slide titles, sheet names, doc title) so downstream Gemini sees
 * structural signal — slide boundaries, speaker notes, sheet boundaries —
 * not just a wall of text.
 *
 * The marker grammar the walkers emit ("# <title>", "## Slide N",
 * "## Sheet: <name>", "### Speaker notes", tab-separated table rows) is
 * documented in extract-markers.ts — the single source of truth shared
 * with extract-vision.ts, the consumer prompts, and the contract test
 * (issue C3 / #36). Keep the walkers and that grammar in lockstep.
 */

import crypto from 'node:crypto';
import mammoth from 'mammoth';
import {
  google,
  type docs_v1,
  type slides_v1,
  type sheets_v4,
} from 'googleapis';
import { config } from '../config';
import { logger } from '../logger';
import { downloadFileBuffer } from './client';
import {
  imageVisionRuntimeAvailable,
  tryVisionImageExtraction,
  tryVisionPdfExtraction,
} from './extract-vision';
import { isVisionEligibleImageMime } from './image-mimes';
import { buildBotOAuthClient } from '../workspace';
import type { ExtractionOutcome, ExtractionSkip, TraversedFile } from './types';

// ── MIME constants ─────────────────────────────────────────────────────────

const MIME = {
  GOOGLE_DOC: 'application/vnd.google-apps.document',
  GOOGLE_SHEET: 'application/vnd.google-apps.spreadsheet',
  GOOGLE_SLIDES: 'application/vnd.google-apps.presentation',
  GOOGLE_FOLDER: 'application/vnd.google-apps.folder',
  SHORTCUT: 'application/vnd.google-apps.shortcut',
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

// All scopes the extractor needs. The 'drive' bot must have consented to
// all of these at authorize time; runtime helper verifies via subset check.
const EXTRACT_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

// ── Lazy clients ─────────────────────────────────────────────────────────────
// One auth client shared across all four Workspace APIs. Cached at the first
// call. Each per-API service constructor takes the same auth — googleapis
// dispatches per-API endpoints internally.

let cachedDocs: docs_v1.Docs | null = null;
let cachedSlides: slides_v1.Slides | null = null;
let cachedSheets: sheets_v4.Sheets | null = null;

async function docsClient(): Promise<docs_v1.Docs> {
  if (cachedDocs) return cachedDocs;
  const auth = await buildBotOAuthClient('drive', EXTRACT_SCOPES);
  cachedDocs = google.docs({ version: 'v1', auth });
  return cachedDocs;
}

async function slidesClient(): Promise<slides_v1.Slides> {
  if (cachedSlides) return cachedSlides;
  const auth = await buildBotOAuthClient('drive', EXTRACT_SCOPES);
  cachedSlides = google.slides({ version: 'v1', auth });
  return cachedSlides;
}

async function sheetsClient(): Promise<sheets_v4.Sheets> {
  if (cachedSheets) return cachedSheets;
  const auth = await buildBotOAuthClient('drive', EXTRACT_SCOPES);
  cachedSheets = google.sheets({ version: 'v4', auth });
  return cachedSheets;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hash(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

function ok(text: string, extractor: string): ExtractionOutcome {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: 'skip', reason: 'empty', detail: `extractor=${extractor}` };
  }
  return { kind: 'ok', text: trimmed, contentHash: hash(trimmed), extractor };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * The size cap only applies to BINARY-DOWNLOAD paths (PDF, DOCX, PPTX,
 * text/*). Google-native files (Docs, Sheets, Slides) are fetched via
 * dedicated APIs that return structured content — no full-file byte
 * transfer happens, so the cost is content-window-truncation (handled
 * downstream in interpret.ts) rather than transfer/memory. A 300 MB
 * Google Slides deck is API-traversed, not downloaded.
 */
function tooLargeForBinaryDownload(file: TraversedFile): ExtractionSkip | null {
  if (file.size && file.size > config.DRIVE_MAX_FILE_SIZE_BYTES) {
    return {
      kind: 'skip',
      reason: 'too_large',
      detail: `size=${file.size} limit=${config.DRIVE_MAX_FILE_SIZE_BYTES}`,
    };
  }
  return null;
}

/**
 * Caller-supplied scope decision for image/* files (issue C2 / #35).
 * Piece scope, count caps, and the relevance floor live in the scan
 * worker — the only call site that knows which piece owns a file — so
 * extractText can't compute them; it just honors the verdict. Callers
 * that pass nothing get allowImageVision=false, i.e. images stay gated.
 */
export interface ExtractOptions {
  /** True only when the scan worker granted this image the vision path. */
  allowImageVision?: boolean;
  /** Why the worker denied it — threaded into the out_of_scope_image
   *  skip's detail (e.g. 'no_piece_scope', 'per_piece_cap'). */
  imageSkipDetail?: string;
}

/**
 * Pure metadata-only check: would extractText skip this file without
 * doing any I/O? Returns the skip outcome if so, null if the file is
 * extraction-eligible (or would fail with a network/parse error, which
 * we can't predict).
 *
 * Mirrors the bail-outs in extractText so callers can predict the
 * outcome without any I/O.
 * Both predictExtractionSkip and extractText route through the same
 * decision tree — extractText calls this first (with the SAME opts),
 * then proceeds to the extraction switch only on null.
 */
export function predictExtractionSkip(
  file: TraversedFile,
  opts?: ExtractOptions,
): ExtractionSkip | null {
  if (file.isFolder) return { kind: 'skip', reason: 'folder' };

  // Shortcut resolution — mirror extractText's three early-exit cases.
  let effective = file;
  let isShortcutFollow = false;
  if (file.mimeType === MIME.SHORTCUT) {
    if (!file.shortcutTarget) {
      return { kind: 'skip', reason: 'unsupported_mime', detail: 'shortcut without resolved target' };
    }
    if (file.shortcutTarget.mimeType === MIME.GOOGLE_FOLDER) {
      return {
        kind: 'skip',
        reason: 'unsupported_mime',
        detail: `shortcut→folder ${file.shortcutTarget.id} (folder-shortcut traversal not yet supported)`,
      };
    }
    if (file.shortcutTarget.mimeType === MIME.SHORTCUT) {
      return { kind: 'skip', reason: 'unsupported_mime', detail: 'shortcut chain (single-level follow only)' };
    }
    effective = {
      ...file,
      id: file.shortcutTarget.id,
      mimeType: file.shortcutTarget.mimeType,
      size: null, // shortcutDetails doesn't include target size — see guard below
    };
    isShortcutFollow = true;
  }

  switch (effective.mimeType) {
    // Google-native: API-traversed, no size cap.
    case MIME.GOOGLE_DOC:
    case MIME.GOOGLE_SLIDES:
    case MIME.GOOGLE_SHEET:
      return null;

    // Binary download paths share the same size guard.
    // NOTE (C1 lockstep): the vision branch in extractText's PDF case is
    // deliberately absent here — it is skip-NEUTRAL. Vision gates and
    // failures fall back to the text-layer path; they never produce a
    // skip, so the predictor's PDF answer is unchanged. If a future
    // change makes vision produce a skip outcome, it MUST be mirrored
    // here (the lockstep test in __tests__/extract.test.ts pins the agreement).
    case MIME.PDF:
    case MIME.DOCX:
    case MIME.PPTX: {
      const tooLarge = tooLargeForBinaryDownload(effective);
      if (tooLarge) return tooLarge;
      // Shortcut→binary with unknown size: we can't verify the cap,
      // and Drive's shortcutDetails doesn't carry the target's size.
      // Default-skip rather than download blindly (the OOM vector).
      // To rescue these, do a single files.get on the target ahead
      // of dispatch — left as a future enhancement.
      if (isShortcutFollow && effective.size == null) {
        return {
          kind: 'skip',
          reason: 'shortcut_unverified_size',
          detail: `${effective.mimeType} via shortcut (target id=${effective.id}); shortcutDetails has no size`,
        };
      }
      return null;
    }

    default:
      // ── image/* (issue C2 / #35) ────────────────────────────────────
      // Lockstep with extractText's image case AND the gates inside
      // tryVisionImageExtraction: whatever skip the runtime would return
      // for metadata-visible reasons is predicted here.
      if (isVisionEligibleImageMime(effective.mimeType)) {
        // Dark launch / mock driver: byte-identical to pre-C2 — a plain
        // unsupported_mime with the mime as detail.
        if (!imageVisionRuntimeAvailable()) {
          return { kind: 'skip', reason: 'unsupported_mime', detail: effective.mimeType };
        }
        // Scope is the caller's verdict (piece folder + caps + relevance
        // floor, computed in the scan worker). No opts = not granted.
        if (!opts?.allowImageVision) {
          return {
            kind: 'skip',
            reason: 'out_of_scope_image',
            ...(opts?.imageSkipDetail ? { detail: opts.imageSkipDetail } : {}),
          };
        }
        // Size gates, mirroring tryVisionImageExtraction's byte cap from
        // Drive's size metadata (no fallback → out_of_scope_image, not
        // too_large: the file still feeds the name-only asset path).
        if (effective.size && effective.size > config.DRIVE_IMAGE_MAX_FILE_SIZE_BYTES) {
          return {
            kind: 'skip',
            reason: 'out_of_scope_image',
            detail: `over_size_cap size=${effective.size} limit=${config.DRIVE_IMAGE_MAX_FILE_SIZE_BYTES}`,
          };
        }
        if (isShortcutFollow && effective.size == null) {
          return {
            kind: 'skip',
            reason: 'shortcut_unverified_size',
            detail: `${effective.mimeType} via shortcut (target id=${effective.id}); shortcutDetails has no size`,
          };
        }
        return null;
      }
      if (effective.mimeType.startsWith('text/')) {
        const tooLarge = tooLargeForBinaryDownload(effective);
        if (tooLarge) return tooLarge;
        if (isShortcutFollow && effective.size == null) {
          return {
            kind: 'skip',
            reason: 'shortcut_unverified_size',
            detail: `${effective.mimeType} via shortcut (target id=${effective.id}); shortcutDetails has no size`,
          };
        }
        return null;
      }
      return { kind: 'skip', reason: 'unsupported_mime', detail: effective.mimeType };
  }
}

export async function extractText(
  file: TraversedFile,
  opts?: ExtractOptions,
): Promise<ExtractionOutcome> {
  // Single source of truth for skip-without-I/O decisions.
  const predicted = predictExtractionSkip(file, opts);
  if (predicted) return predicted;

  // Resolve the shortcut to its target. predictExtractionSkip already
  // verified the shortcut's target exists, isn't a folder, isn't a
  // chain, and (for binary mimes) has a verifiable size — so this
  // rebuild is safe.
  let effectiveFile = file;
  if (file.mimeType === MIME.SHORTCUT && file.shortcutTarget) {
    effectiveFile = {
      ...file,
      id: file.shortcutTarget.id,
      mimeType: file.shortcutTarget.mimeType,
      size: null,
    };
    delete (effectiveFile as { shortcutTarget?: unknown }).shortcutTarget;
  }

  try {
    switch (effectiveFile.mimeType) {
      // ── Google-native: API-traversed, NO size cap. Content-window
      //    truncation handled downstream by GEMINI_MAX_INPUT_CHARS.
      case MIME.GOOGLE_DOC:
        return ok(await extractGoogleDoc(effectiveFile.id), 'gdoc');
      case MIME.GOOGLE_SLIDES:
        return ok(await extractGoogleSlides(effectiveFile.id), 'gslides');
      case MIME.GOOGLE_SHEET:
        return ok(await extractGoogleSheets(effectiveFile.id), 'gsheet');

      // ── Binary downloads: size cap already checked in predictExtractionSkip.
      case MIME.PDF: {
        const buf = await downloadFileBuffer(effectiveFile.id);
        // Vision-first (issue C1): Gemini document understanding reads
        // layout, charts, and image-set decks the text layer can't.
        // Every gate and failure inside tryVisionPdfExtraction returns
        // null and lands on the text-layer path below — the vision
        // branch never skips and never throws, which is what keeps
        // predictExtractionSkip's decision tree untouched (the
        // predictor's PDF answer is identical whether vision or the
        // text layer ends up producing the text).
        const visionText = await tryVisionPdfExtraction(effectiveFile, buf);
        if (visionText !== null) return ok(visionText, 'vision');
        // Import lazily to keep the parser off the module init path.
        //
        // `unpdf` is a thin modern wrapper over `pdfjs-dist`'s legacy
        // build — the build Mozilla maintains specifically for Node /
        // serverless environments without DOM globals. We deliberately
        // do NOT use pdf-parse: v1.x is unmaintained (last release
        // 2019), and v2.x is a rewrite on top of the non-legacy
        // pdfjs-dist build that expects browser globals (DOMMatrix,
        // Path2D, ImageData) and throws in Node without `canvas`
        // native-dep polyfills. unpdf is the actively-maintained
        // primitive that exists precisely because of v2's breakage.
        //
        // We construct the PDFDocumentProxy explicitly (rather than
        // passing raw bytes to extractText) so we can set pdfjs's
        // `verbosity` level. Default is WARNINGS, which spams the log
        // with harmless TrueType-font notes like "TT: undefined
        // function: 32" — those don't affect text extraction but
        // drown out real signal. verbosity: 0 = ERRORS only.
        const { getDocumentProxy, extractText } = await import('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
        const { text } = await extractText(pdf, { mergePages: true });
        return ok(text, 'pdf');
      }
      case MIME.DOCX: {
        const buf = await downloadFileBuffer(effectiveFile.id);
        const { value } = await mammoth.extractRawText({ buffer: buf });
        return ok(value, 'docx');
      }
      case MIME.PPTX: {
        const buf = await downloadFileBuffer(effectiveFile.id);
        // Import lazily to keep officeparser off the module init path —
        // it has a heavy zlib/xml unpack chain we'd rather defer.
        // officeparser flattens to plain text; slide boundaries and
        // speaker notes are mostly preserved as runs of lines.
        //
        // PPTX does NOT get the vision path (C1): Gemini inline document
        // understanding accepts PDF only — PPTX would need a PDF
        // conversion step first. Decks benefit from vision when they're
        // PDF exports (the common agency case, covered above). For a
        // PPTX conversion pipeline see the future "rich pipeline" plan
        // in docs/status-markdown-plan.md.
        const { parseOfficeAsync } = await import('officeparser');
        const text = await parseOfficeAsync(buf);
        return ok(text, 'pptx');
      }
      default: {
        // ── image/* (issue C2 / #35) ──────────────────────────────────
        // Reaching here means predictExtractionSkip said eligible: the
        // runtime gate is open AND the caller granted scope. Images have
        // NO text fallback (unlike the PDF vision branch above), so every
        // gate/failure inside tryVisionImageExtraction returns a SKIP,
        // never a throw — an unreadable image must never fail the scan.
        // downloadFileBuffer errors still propagate on purpose: a 403
        // here feeds the restricted-file worklist like any other binary.
        if (isVisionEligibleImageMime(effectiveFile.mimeType)) {
          const buf = await downloadFileBuffer(effectiveFile.id);
          const vision = await tryVisionImageExtraction(effectiveFile, buf);
          return typeof vision === 'string' ? ok(vision, 'vision-image') : vision;
        }
        if (effectiveFile.mimeType.startsWith('text/')) {
          const buf = await downloadFileBuffer(effectiveFile.id);
          return ok(buf.toString('utf-8'), 'plaintext');
        }
        // predictExtractionSkip would have caught this above; defensive
        // fall-through in case extractText gets called with a file the
        // predictor said was extractable but isn't.
        return { kind: 'skip', reason: 'unsupported_mime', detail: effectiveFile.mimeType };
      }
    }
  } catch (err) {
    // Demoted to debug: drive.sync.ts catches this throw and routes the
    // full payload to drive_scan_logs + a one-line summary to progress.
    logger.debug(
      { err, fileId: effectiveFile.id, name: file.name, mimeType: effectiveFile.mimeType },
      '[drive] extraction failed',
    );
    throw err;
  }
}

// ── Google Docs walker ──────────────────────────────────────────────────────
// Docs API `documents.get` returns a tree where the body is body.content[],
// each element being one of paragraph | table | sectionBreak | tableOfContents.
// We walk recursively and concatenate textRun.content (the actual text).

export async function extractGoogleDoc(documentId: string): Promise<string> {
  const client = await docsClient();
  const res = await client.documents.get({ documentId });
  const doc = res.data;
  const parts: string[] = [];

  if (doc.title) parts.push(`# ${doc.title}\n\n`);

  for (const element of doc.body?.content ?? []) {
    parts.push(walkDocStructuralElement(element));
  }

  return parts.join('');
}

function walkDocStructuralElement(el: docs_v1.Schema$StructuralElement): string {
  if (el.paragraph) {
    return walkDocParagraph(el.paragraph);
  }
  if (el.table) {
    return walkDocTable(el.table);
  }
  if (el.tableOfContents?.content) {
    // TOC is itself a tree of structural elements.
    return el.tableOfContents.content.map(walkDocStructuralElement).join('');
  }
  // sectionBreak and other element types: no text content worth extracting.
  return '';
}

function walkDocParagraph(p: docs_v1.Schema$Paragraph): string {
  // Each paragraph element already ends with \n in Google's content (the
  // textRun's content string includes the trailing newline). Just join.
  return (p.elements ?? [])
    .map((e) => e.textRun?.content ?? '')
    .join('');
}

function walkDocTable(t: docs_v1.Schema$Table): string {
  // Tab-separate cells within a row, newline-separate rows. Each cell's
  // content is itself a list of structural elements (usually paragraphs).
  const rows = (t.tableRows ?? []).map((row) =>
    (row.tableCells ?? [])
      .map((cell) =>
        (cell.content ?? [])
          .map(walkDocStructuralElement)
          .join('')
          .replace(/\n/g, ' ') // flatten cell paragraphs
          .trim(),
      )
      .join('\t'),
  );
  return rows.join('\n') + '\n';
}

// ── Google Slides walker ────────────────────────────────────────────────────
// Slides API `presentations.get` returns a tree: presentation.slides[] →
// pageElements[] → shape.text.textElements[].textRun.content (and also
// tables, element groups). Each slide also has slideProperties.notesPage
// with speaker-notes pageElements.

export async function extractGoogleSlides(presentationId: string): Promise<string> {
  const client = await slidesClient();
  const res = await client.presentations.get({ presentationId });
  const pres = res.data;
  const parts: string[] = [];

  if (pres.title) parts.push(`# ${pres.title}\n\n`);

  for (const [i, slide] of (pres.slides ?? []).entries()) {
    // Skipped slides (slideProperties.isSkipped) are deliberately hidden by
    // the deck's authors — killed concepts, old rounds, appendix. They never
    // enter the pipeline: what the team cut must not feed interpretation,
    // dossiers, or idea extraction. Numbering keeps the original slide index
    // so extracted text cross-references the real deck.
    if (slide.slideProperties?.isSkipped) continue;
    parts.push(`## Slide ${i + 1}\n\n`);

    // Slide body: walk page elements in declared order.
    for (const el of slide.pageElements ?? []) {
      const text = walkSlidesPageElement(el);
      if (text) parts.push(text);
    }

    // Speaker notes: live on slideProperties.notesPage.pageElements
    // (a separate page entirely). We section them off so Gemini sees them
    // as notes, not main slide content.
    const notesEls = slide.slideProperties?.notesPage?.pageElements ?? [];
    const notes = notesEls
      .map(walkSlidesPageElement)
      .join('')
      .trim();
    if (notes) {
      parts.push(`\n### Speaker notes\n${notes}\n`);
    }

    parts.push('\n');
  }

  return parts.join('');
}

function walkSlidesPageElement(el: slides_v1.Schema$PageElement): string {
  if (el.shape?.text) {
    const text = (el.shape.text.textElements ?? [])
      .map((te) => te.textRun?.content ?? '')
      .join('');
    return text ? text.replace(/\n+$/, '') + '\n' : '';
  }
  if (el.table) {
    return walkSlidesTable(el.table);
  }
  if (el.elementGroup?.children) {
    return el.elementGroup.children.map(walkSlidesPageElement).join('');
  }
  // Image, video, line, sheetsChart, wordArt, etc. — no text to extract.
  return '';
}

function walkSlidesTable(t: slides_v1.Schema$Table): string {
  const rows = (t.tableRows ?? []).map((row) =>
    (row.tableCells ?? [])
      .map((cell) =>
        (cell.text?.textElements ?? [])
          .map((te) => te.textRun?.content ?? '')
          .join('')
          .replace(/\n/g, ' ')
          .trim(),
      )
      .join('\t'),
  );
  return rows.join('\n') + '\n';
}

// ── Google Sheets walker ────────────────────────────────────────────────────
// Two-call pattern:
//   1. spreadsheets.get (metadata-only fields) — enumerates the workbook's
//      sheets so we know what ranges to request.
//   2. spreadsheets.values.batchGet — one batched request for all sheets'
//      values, with FORMATTED_VALUE so currency/date display strings come
//      through (matches what a user would see, not raw numbers).

export async function extractGoogleSheets(spreadsheetId: string): Promise<string> {
  const client = await sheetsClient();

  // Step 1: enumerate sheets.
  const meta = await client.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties(title,sheetId)',
  });

  const workbookTitle = meta.data.properties?.title;
  const sheetTitles = (meta.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => !!t);

  if (sheetTitles.length === 0) return '';

  // Step 2: batch values fetch. One range per sheet, naming the whole sheet.
  const values = await client.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: sheetTitles,
    valueRenderOption: 'FORMATTED_VALUE',
  });

  const parts: string[] = [];
  if (workbookTitle) parts.push(`# ${workbookTitle}\n\n`);

  for (const vr of values.data.valueRanges ?? []) {
    // vr.range looks like "Sheet1!A1:Z1000" or "'Q3 Plan'!A1:..." for sheet
    // names with spaces. Extract just the sheet name for the header.
    const range = vr.range ?? '';
    const sheetName = (range.split('!')[0] ?? '').replace(/^'(.*)'$/, '$1');
    parts.push(`## Sheet: ${sheetName}\n`);

    for (const row of vr.values ?? []) {
      const cells = (row as unknown[]).map((c) => String(c ?? ''));
      parts.push(cells.join('\t') + '\n');
    }
    parts.push('\n');
  }

  return parts.join('');
}
