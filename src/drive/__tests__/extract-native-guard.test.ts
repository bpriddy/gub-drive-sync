/**
 * Character guard on the Google-native extractors (Docs, Slides, Sheets).
 *
 * These files have no byte size to check before the read, so extractText caps
 * the walked text instead: over NATIVE_MAX_CHARS the file is skipped with the
 * reason 'too_many_chars' and a WARN is logged; at the limit it is extracted.
 * The limit is set from the real walker's own output length, so "at" and "one
 * over" are exact whatever headings the walker adds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { googleMock, docsGet, presentationsGet, sheetsGet, sheetsBatchGet, warnLog, cfg } =
  vi.hoisted(() => ({
    googleMock: { docs: vi.fn(), slides: vi.fn(), sheets: vi.fn() },
    docsGet: vi.fn(),
    presentationsGet: vi.fn(),
    sheetsGet: vi.fn(),
    sheetsBatchGet: vi.fn(),
    warnLog: vi.fn(),
    cfg: { DRIVE_MAX_FILE_SIZE_BYTES: 26214400, NATIVE_MAX_CHARS: 2_000_000 },
  }));

vi.mock('googleapis', () => ({
  google: { ...googleMock, drive: vi.fn(() => ({})) },
}));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn().mockResolvedValue({}) }));
vi.mock('../../config', () => ({ config: cfg }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: warnLog, error: vi.fn() },
}));
vi.mock('../client', () => ({ downloadFileBuffer: vi.fn() }));

import {
  extractGoogleDoc,
  extractGoogleSheets,
  extractGoogleSlides,
  extractText,
  predictExtractionSkip,
} from '../extract';
import type { TraversedFile } from '../types';

const MIME_DOC = 'application/vnd.google-apps.document';
const MIME_SLIDES = 'application/vnd.google-apps.presentation';
const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';

const WARN_MESSAGE = '[drive.extract] native text over NATIVE_MAX_CHARS — skipped';

function file(mimeType: string, id = 'native-1'): TraversedFile {
  return {
    id,
    name: 'Acme planning',
    mimeType,
    path: 'Acme / Planning',
    modifiedTime: null,
    modifiedByEmail: null,
    createdTime: null,
    size: null,
    isFolder: false,
  };
}

interface Native {
  label: string;
  mime: string;
  extractor: 'gdoc' | 'gslides' | 'gsheet';
  /** Make the fake API return `chars` characters of body text. */
  respondWith(chars: number): void;
  /** Length of what the real walker produces for the current API response. */
  walkedLength(): Promise<number>;
}

const natives: Native[] = [
  {
    label: 'Google Doc',
    mime: MIME_DOC,
    extractor: 'gdoc',
    respondWith: (chars) =>
      docsGet.mockResolvedValue({
        data: {
          body: {
            content: [{ paragraph: { elements: [{ textRun: { content: 'x'.repeat(chars) } }] } }],
          },
        },
      }),
    walkedLength: async () => (await extractGoogleDoc('native-1')).length,
  },
  {
    label: 'Google Slides',
    mime: MIME_SLIDES,
    extractor: 'gslides',
    respondWith: (chars) =>
      presentationsGet.mockResolvedValue({
        data: {
          title: 'Deck',
          slides: [
            {
              pageElements: [
                {
                  shape: { text: { textElements: [{ textRun: { content: 'x'.repeat(chars) } }] } },
                },
              ],
            },
          ],
        },
      }),
    walkedLength: async () => (await extractGoogleSlides('native-1')).length,
  },
  {
    label: 'Google Sheet',
    mime: MIME_SHEET,
    extractor: 'gsheet',
    respondWith: (chars) => {
      sheetsGet.mockResolvedValue({
        data: { properties: { title: 'Plan' }, sheets: [{ properties: { title: 'Q3' } }] },
      });
      sheetsBatchGet.mockResolvedValue({
        data: { valueRanges: [{ range: 'Q3!A1:A1', values: [['x'.repeat(chars)]] }] },
      });
    },
    walkedLength: async () => (await extractGoogleSheets('native-1')).length,
  },
];

beforeEach(() => {
  cfg.NATIVE_MAX_CHARS = 2_000_000;
  warnLog.mockReset();
  for (const m of [docsGet, presentationsGet, sheetsGet, sheetsBatchGet]) m.mockReset();
  googleMock.docs.mockReturnValue({ documents: { get: docsGet } });
  googleMock.slides.mockReturnValue({ presentations: { get: presentationsGet } });
  googleMock.sheets.mockReturnValue({
    spreadsheets: { get: sheetsGet, values: { batchGet: sheetsBatchGet } },
  });
});

describe.each(natives)('extractText on a $label', (n) => {
  it('extracts text that is exactly at NATIVE_MAX_CHARS', async () => {
    n.respondWith(500);
    const length = await n.walkedLength();
    cfg.NATIVE_MAX_CHARS = length;

    const outcome = await extractText(file(n.mime));

    expect(outcome).toMatchObject({ kind: 'ok', extractor: n.extractor });
    expect(warnLog).not.toHaveBeenCalled();
  });

  it('skips text one character over NATIVE_MAX_CHARS, with the new reason and a WARN', async () => {
    n.respondWith(500);
    const length = await n.walkedLength();
    cfg.NATIVE_MAX_CHARS = length - 1;

    const outcome = await extractText(file(n.mime, 'native-42'));

    expect(outcome).toEqual({
      kind: 'skip',
      reason: 'too_many_chars',
      detail: `extractor=${n.extractor} chars=${length} limit=${length - 1}`,
    });
    // Ids, sizes and codes only: no name, path or text in the structured fields.
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledWith(
      { fileId: 'native-42', extractor: n.extractor, chars: length, limit: length - 1 },
      WARN_MESSAGE,
    );
  });

  it('skips an enormous result at the default limit', async () => {
    n.respondWith(2_000_001);

    const outcome = await extractText(file(n.mime));

    expect(outcome).toMatchObject({ kind: 'skip', reason: 'too_many_chars' });
    expect(warnLog).toHaveBeenCalledTimes(1);
  });
});

describe('the guard leaves the other native outcomes alone', () => {
  it('still reports an empty document as empty, not as too many chars', async () => {
    docsGet.mockResolvedValue({ data: { body: { content: [] } } });
    cfg.NATIVE_MAX_CHARS = 10;

    expect(await extractText(file(MIME_DOC))).toEqual({
      kind: 'skip',
      reason: 'empty',
      detail: 'extractor=gdoc',
    });
    expect(warnLog).not.toHaveBeenCalled();
  });

  it('logs the TARGET id for a shortcut that follows to an over-long Doc', async () => {
    natives[0]!.respondWith(500);
    cfg.NATIVE_MAX_CHARS = 100;
    const shortcut: TraversedFile = {
      ...file('application/vnd.google-apps.shortcut', 'shortcut-1'),
      shortcutTarget: { id: 'target-doc-9', mimeType: MIME_DOC },
    };

    expect(await extractText(shortcut)).toMatchObject({ kind: 'skip', reason: 'too_many_chars' });
    expect(docsGet).toHaveBeenCalledWith({ documentId: 'target-doc-9' });
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'target-doc-9', extractor: 'gdoc' }),
      WARN_MESSAGE,
    );
  });

  it('cannot predict the guard from metadata: native files are never pre-skipped', () => {
    cfg.NATIVE_MAX_CHARS = 1;
    for (const n of natives) expect(predictExtractionSkip(file(n.mime))).toBeNull();
  });

  it('keeps the existing byte-size skip for binaries unchanged', () => {
    const big: TraversedFile = {
      ...file('application/pdf'),
      size: cfg.DRIVE_MAX_FILE_SIZE_BYTES + 1,
    };
    expect(predictExtractionSkip(big)).toEqual({
      kind: 'skip',
      reason: 'too_large',
      detail: `size=${big.size} limit=${cfg.DRIVE_MAX_FILE_SIZE_BYTES}`,
    });
  });
});
