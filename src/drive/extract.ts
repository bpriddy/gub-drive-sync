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
 *     - application/pdf                     → pdf-parse           (extractor='pdf')
 *     - application/vnd.openxmlformats-…wordprocessingml.document  → mammoth (.docx)
 *     - text/* (plaintext, markdown, csv, etc.) → direct download (extractor='plaintext')
 *
 *   Anything else → skip with reason='unsupported_mime'.
 *
 * Each Google-native walker produces structured-but-flat text with section
 * markers (slide titles, sheet names, doc title) so downstream Gemini sees
 * structural signal — slide boundaries, speaker notes, sheet boundaries —
 * not just a wall of text.
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
import { buildBotOAuthClient } from '../workspace';
import type { ExtractionOutcome, TraversedFile } from './types';

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
function tooLargeForBinaryDownload(file: TraversedFile): ExtractionOutcome | null {
  if (file.size && file.size > config.DRIVE_MAX_FILE_SIZE_BYTES) {
    return {
      kind: 'skip',
      reason: 'too_large',
      detail: `size=${file.size} limit=${config.DRIVE_MAX_FILE_SIZE_BYTES}`,
    };
  }
  return null;
}

export async function extractText(file: TraversedFile): Promise<ExtractionOutcome> {
  if (file.isFolder) return { kind: 'skip', reason: 'folder' };

  // ── Shortcut follow (single-level, greedy across drives) ──────────────
  // Drive shortcuts (mimeType=application/vnd.google-apps.shortcut) are
  // pointers to another file or folder. The shortcut row has no content
  // of its own; the real content lives at shortcutTarget.id. We follow
  // greedily — including cross-drive targets — because shortcuts often
  // surface shared assets (brand libraries, briefs in other folders)
  // that are otherwise invisible to the per-entity scan.
  //
  // Limit: single-level follow only. Shortcut-to-shortcut chains are
  // impossible to create in Drive's UI but we guard defensively. Folder
  // shortcuts get skipped (logged) — traversing the target folder
  // through a shortcut is a v2 feature (changes the gather phase, not
  // just the extractor). File shortcuts dispatch into the normal switch
  // below with the target's mimeType.
  let effectiveFile = file;
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
      // Defensive: shortcut chains aren't really constructible but guard anyway.
      return { kind: 'skip', reason: 'unsupported_mime', detail: 'shortcut chain (single-level follow only)' };
    }
    // Rebuild a virtual file pointing at the target. Keep the shortcut's
    // name/path so traversal breadcrumbs and progress lines still
    // identify WHERE the content was reached from. Clear size — the
    // shortcut's size attribute reflects the pointer, not the target.
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

      // ── Binary downloads: size cap applies; we pull bytes into memory.
      case MIME.PDF: {
        const tooLarge = tooLargeForBinaryDownload(effectiveFile);
        if (tooLarge) return tooLarge;
        const buf = await downloadFileBuffer(effectiveFile.id);
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
        const tooLarge = tooLargeForBinaryDownload(effectiveFile);
        if (tooLarge) return tooLarge;
        const buf = await downloadFileBuffer(effectiveFile.id);
        const { value } = await mammoth.extractRawText({ buffer: buf });
        return ok(value, 'docx');
      }
      case MIME.PPTX: {
        const tooLarge = tooLargeForBinaryDownload(effectiveFile);
        if (tooLarge) return tooLarge;
        const buf = await downloadFileBuffer(effectiveFile.id);
        // Import lazily to keep officeparser off the module init path —
        // it has a heavy zlib/xml unpack chain we'd rather defer.
        // officeparser flattens to plain text; slide boundaries and
        // speaker notes are mostly preserved as runs of lines. For
        // richer visual understanding (charts/photos/layout), see the
        // future "rich pipeline" plan in docs/status-markdown-plan.md.
        const { parseOfficeAsync } = await import('officeparser');
        const text = await parseOfficeAsync(buf);
        return ok(text, 'pptx');
      }
      default: {
        if (effectiveFile.mimeType.startsWith('text/')) {
          const tooLarge = tooLargeForBinaryDownload(effectiveFile);
          if (tooLarge) return tooLarge;
          const buf = await downloadFileBuffer(effectiveFile.id);
          return ok(buf.toString('utf-8'), 'plaintext');
        }
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
