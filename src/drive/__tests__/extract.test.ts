/**
 * Unit tests for drive.extract.ts.
 *
 * Walkers: each is tested against representative API response shapes (the
 * structural variations that matter — paragraph + table + nested toc for
 * Docs, slide + speaker notes + table for Slides, multi-sheet workbook for
 * Sheets). We don't test the integration with the real Google APIs here;
 * the debug script + production sync runs do that.
 *
 * What we DO test:
 *   - Each walker produces structured-but-flat text with section markers
 *     (titles, slide numbers, sheet names, speaker-notes)
 *   - Empty/missing fields don't crash the walker
 *   - Tables flatten predictably (tab-separated cells, newline-separated rows)
 *
 * Vision path (issue C1): the PDF branch goes vision-first with automatic
 * fallback to the text-layer parser. We pin:
 *   - vision success → extractor='vision'
 *   - EVERY vision gate/failure (error, empty output, size/page caps,
 *     disabled, mock LLM driver) → silent fallback to extractor='pdf',
 *     never a throw, never a skip
 *   - predictExtractionSkip ↔ extractText lockstep: across the whole MIME
 *     matrix, a predicted skip is returned verbatim by extractText and a
 *     predicted null extracts ok — the vision branch must stay skip-neutral
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks for the three Workspace API clients. We don't go through
// the real googleapis factory; we mock at the buildBotOAuthClient boundary
// so the cached clients in drive.extract.ts capture our fakes.
const { googleMock, buildBotOAuthClientMock, docsGet, presentationsGet, sheetsGet, sheetsBatchGet } =
  vi.hoisted(() => ({
    googleMock: {
      docs: vi.fn(),
      slides: vi.fn(),
      sheets: vi.fn(),
    },
    buildBotOAuthClientMock: vi.fn(),
    docsGet: vi.fn(),
    presentationsGet: vi.fn(),
    sheetsGet: vi.fn(),
    sheetsBatchGet: vi.fn(),
  }));

vi.mock('googleapis', () => ({
  google: {
    docs: googleMock.docs,
    slides: googleMock.slides,
    sheets: googleMock.sheets,
    // drive() isn't called by the walkers we're testing here, but the
    // module imports drive.client which imports googleapis transitively.
    // Stub it to a harmless no-op factory.
    drive: vi.fn(() => ({})),
    auth: { OAuth2: vi.fn() },
  },
}));

vi.mock('../../workspace', () => ({
  buildBotOAuthClient: buildBotOAuthClientMock,
}));

// Mutable config so vision-gate tests can flip knobs per-test; beforeEach
// restores the defaults. Shared by extract.ts AND extract-vision.ts.
const { mockConfig, CONFIG_DEFAULTS } = vi.hoisted(() => {
  const CONFIG_DEFAULTS = {
    DRIVE_MAX_FILE_SIZE_BYTES: 26214400,
    DRIVE_VISION_ENABLED: true,
    DRIVE_VISION_MODEL: undefined as string | undefined,
    DRIVE_VISION_MAX_FILE_SIZE_BYTES: 14680064,
    DRIVE_VISION_MAX_PDF_PAGES: 50,
    DRIVE_VISION_MAX_OUTPUT_TOKENS: 32768,
    DRIVE_VISION_TIMEOUT_MS: 180000,
  };
  return { mockConfig: { ...CONFIG_DEFAULTS }, CONFIG_DEFAULTS };
});

vi.mock('../../config', () => ({
  config: mockConfig,
}));

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../client', () => ({
  downloadFileBuffer: vi.fn(),
}));

// LLM driver mock (vision path). Mutable `name` lets the mock-driver
// gate test flip it to 'mock'; beforeEach restores 'gemini'.
const { llmComplete, llmDriver } = vi.hoisted(() => {
  const llmComplete = vi.fn();
  return { llmComplete, llmDriver: { name: 'gemini', complete: llmComplete } };
});

// Mocking '../../ai' also keeps its prisma-importing preset service out of
// the unit suite (hermeticity — see the CI note in the repo history).
vi.mock('../../ai', () => ({
  defaultLlm: llmDriver,
  DEFAULT_GEMINI_MODEL: 'gemini-3.5-flash',
}));

// Binary parsers, mocked so extractText's non-Google branches run without
// real parsing. unpdf serves double duty: page count for the vision gate
// AND the text-layer fallback.
const { unpdfGetDocumentProxy, unpdfExtractText, officeParse, mammothExtract } = vi.hoisted(
  () => ({
    unpdfGetDocumentProxy: vi.fn(),
    unpdfExtractText: vi.fn(),
    officeParse: vi.fn(),
    mammothExtract: vi.fn(),
  }),
);

vi.mock('unpdf', () => ({
  getDocumentProxy: unpdfGetDocumentProxy,
  extractText: unpdfExtractText,
}));

vi.mock('officeparser', () => ({
  parseOfficeAsync: officeParse,
}));

vi.mock('mammoth', () => ({
  default: { extractRawText: mammothExtract },
}));

beforeEach(() => {
  Object.assign(mockConfig, CONFIG_DEFAULTS);
  llmDriver.name = 'gemini';
  buildBotOAuthClientMock.mockReset();
  buildBotOAuthClientMock.mockResolvedValue({ /* dummy auth client */ });
  docsGet.mockReset();
  presentationsGet.mockReset();
  sheetsGet.mockReset();
  sheetsBatchGet.mockReset();
  googleMock.docs.mockReturnValue({ documents: { get: docsGet } });
  googleMock.slides.mockReturnValue({ presentations: { get: presentationsGet } });
  googleMock.sheets.mockReturnValue({
    spreadsheets: { get: sheetsGet, values: { batchGet: sheetsBatchGet } },
  });

  // Happy-path defaults for the binary branches; individual tests override.
  vi.mocked(downloadFileBuffer).mockReset();
  vi.mocked(downloadFileBuffer).mockResolvedValue(Buffer.from('%PDF-1.4 fake bytes'));
  llmComplete.mockReset();
  llmComplete.mockResolvedValue({
    text: '# Vision Doc\n\n## Page 1\nvision transcription',
    driver: 'gemini',
    model: 'gemini-3.5-flash',
  });
  unpdfGetDocumentProxy.mockReset();
  unpdfGetDocumentProxy.mockResolvedValue({ numPages: 3 });
  unpdfExtractText.mockReset();
  unpdfExtractText.mockResolvedValue({ text: 'text-layer extraction' });
  officeParse.mockReset();
  officeParse.mockResolvedValue('pptx text');
  mammothExtract.mockReset();
  mammothExtract.mockResolvedValue({ value: 'docx text' });
});

import {
  extractText,
  predictExtractionSkip,
  extractGoogleDoc,
  extractGoogleSlides,
  extractGoogleSheets,
} from '../extract';
import { downloadFileBuffer } from '../client';
import type { TraversedFile } from '../types';

/** Minimal TraversedFile factory for the dispatch/vision/lockstep tests. */
function makeFile(overrides: Partial<TraversedFile>): TraversedFile {
  return {
    id: 'file-1',
    name: 'file.pdf',
    mimeType: 'application/pdf',
    path: 'Acme / Q3 / file.pdf',
    modifiedTime: null,
    modifiedByEmail: null,
    createdTime: null,
    size: 1024,
    isFolder: false,
    ...overrides,
  };
}

// ── Google Docs walker ──────────────────────────────────────────────────────

describe('extractGoogleDoc', () => {
  it('emits title + paragraphs + table cells in document order', async () => {
    docsGet.mockResolvedValue({
      data: {
        title: 'Q3 Launch Brief',
        body: {
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: 'Primary contact: Bob Smith\n' } }],
              },
            },
            {
              paragraph: {
                elements: [
                  { textRun: { content: 'Industry: ' } },
                  { textRun: { content: 'SaaS\n' } },
                ],
              },
            },
            {
              table: {
                tableRows: [
                  {
                    tableCells: [
                      {
                        content: [
                          { paragraph: { elements: [{ textRun: { content: 'Header A' } }] } },
                        ],
                      },
                      {
                        content: [
                          { paragraph: { elements: [{ textRun: { content: 'Header B' } }] } },
                        ],
                      },
                    ],
                  },
                  {
                    tableCells: [
                      {
                        content: [
                          { paragraph: { elements: [{ textRun: { content: 'cell1' } }] } },
                        ],
                      },
                      {
                        content: [
                          { paragraph: { elements: [{ textRun: { content: 'cell2' } }] } },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    });

    const text = await extractGoogleDoc('doc-id-1');
    expect(text).toContain('# Q3 Launch Brief');
    expect(text).toContain('Primary contact: Bob Smith');
    expect(text).toContain('Industry: SaaS');
    expect(text).toContain('Header A\tHeader B');
    expect(text).toContain('cell1\tcell2');
  });

  it("doesn't crash on empty body", async () => {
    docsGet.mockResolvedValue({ data: { title: 'Empty', body: { content: [] } } });
    const text = await extractGoogleDoc('doc-id');
    expect(text).toBe('# Empty\n\n');
  });

  it('handles paragraphs with no textRun (e.g. inlineObjectElement only)', async () => {
    docsGet.mockResolvedValue({
      data: {
        body: {
          content: [
            {
              paragraph: {
                elements: [
                  { inlineObjectElement: { inlineObjectId: 'img-1' } }, // no textRun
                ],
              },
            },
          ],
        },
      },
    });
    await expect(extractGoogleDoc('doc-id')).resolves.toBe('');
  });
});

// ── Google Slides walker ────────────────────────────────────────────────────

describe('extractGoogleSlides', () => {
  it('emits title + slides with per-slide header + speaker notes', async () => {
    presentationsGet.mockResolvedValue({
      data: {
        title: 'Acme Q3 Pitch',
        slides: [
          {
            objectId: 'slide-1',
            pageElements: [
              {
                shape: {
                  text: {
                    textElements: [
                      { textRun: { content: 'Welcome to Q3\n' } },
                    ],
                  },
                },
              },
              {
                shape: {
                  text: {
                    textElements: [
                      { textRun: { content: 'Bullet one\nBullet two\n' } },
                    ],
                  },
                },
              },
            ],
            slideProperties: {
              notesPage: {
                pageElements: [
                  {
                    shape: {
                      text: {
                        textElements: [
                          { textRun: { content: "Mention Bob's role" } },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
          {
            objectId: 'slide-2',
            pageElements: [
              {
                shape: {
                  text: {
                    textElements: [{ textRun: { content: 'Goals\n' } }],
                  },
                },
              },
            ],
          },
        ],
      },
    });

    const text = await extractGoogleSlides('pres-id-1');
    expect(text).toContain('# Acme Q3 Pitch');
    expect(text).toContain('## Slide 1');
    expect(text).toContain('Welcome to Q3');
    expect(text).toContain('Bullet one');
    expect(text).toContain('### Speaker notes');
    expect(text).toContain("Mention Bob's role");
    expect(text).toContain('## Slide 2');
    expect(text).toContain('Goals');
  });

  it('flattens table cells inside a slide', async () => {
    presentationsGet.mockResolvedValue({
      data: {
        slides: [
          {
            pageElements: [
              {
                table: {
                  tableRows: [
                    {
                      tableCells: [
                        { text: { textElements: [{ textRun: { content: 'A1' } }] } },
                        { text: { textElements: [{ textRun: { content: 'B1' } }] } },
                      ],
                    },
                    {
                      tableCells: [
                        { text: { textElements: [{ textRun: { content: 'A2' } }] } },
                        { text: { textElements: [{ textRun: { content: 'B2' } }] } },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    const text = await extractGoogleSlides('pres-id');
    expect(text).toContain('A1\tB1');
    expect(text).toContain('A2\tB2');
  });

  it('skips elements with no text (images, videos)', async () => {
    presentationsGet.mockResolvedValue({
      data: {
        slides: [
          {
            pageElements: [
              { image: { contentUrl: 'http://x' } },
              { video: { url: 'http://y' } },
              { shape: { text: { textElements: [{ textRun: { content: 'real text' } }] } } },
            ],
          },
        ],
      },
    });

    const text = await extractGoogleSlides('pres-id');
    expect(text).toContain('real text');
  });

  it("doesn't crash on a presentation with no slides", async () => {
    presentationsGet.mockResolvedValue({ data: { title: 'Empty', slides: [] } });
    await expect(extractGoogleSlides('pres-id')).resolves.toBe('# Empty\n\n');
  });
});

// ── Google Sheets walker ────────────────────────────────────────────────────

describe('extractGoogleSheets', () => {
  it('enumerates sheets via spreadsheets.get, then batchGets values for all of them', async () => {
    sheetsGet.mockResolvedValue({
      data: {
        properties: { title: 'Q3 Plan' },
        sheets: [
          { properties: { title: 'Forecast', sheetId: 0 } },
          { properties: { title: 'Pipeline', sheetId: 1 } },
        ],
      },
    });
    sheetsBatchGet.mockResolvedValue({
      data: {
        valueRanges: [
          {
            range: 'Forecast!A1:Z1000',
            values: [
              ['Month', 'Revenue'],
              ['Jan', '$100k'],
              ['Feb', '$120k'],
            ],
          },
          {
            range: "'Pipeline'!A1:Z1000",
            values: [
              ['Deal', 'Stage'],
              ['Acme', 'Closed Won'],
            ],
          },
        ],
      },
    });

    const text = await extractGoogleSheets('ssheet-id-1');

    // Workbook title
    expect(text).toContain('# Q3 Plan');
    // Sheet headers — note the single-quoted second sheet name is stripped
    expect(text).toContain('## Sheet: Forecast');
    expect(text).toContain('## Sheet: Pipeline');
    // Tab-separated cells, newline-separated rows
    expect(text).toContain('Month\tRevenue');
    expect(text).toContain('Jan\t$100k');
    expect(text).toContain('Feb\t$120k');
    expect(text).toContain('Deal\tStage');
    expect(text).toContain('Acme\tClosed Won');
    // Requested FORMATTED_VALUE so currency strings come through (we hand
    // them straight to Gemini)
    expect(sheetsBatchGet).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: 'ssheet-id-1',
        ranges: ['Forecast', 'Pipeline'],
        valueRenderOption: 'FORMATTED_VALUE',
      }),
    );
  });

  it('returns empty string when the spreadsheet has no sheets at all', async () => {
    sheetsGet.mockResolvedValue({
      data: { properties: { title: 'Empty' }, sheets: [] },
    });
    const text = await extractGoogleSheets('id');
    expect(text).toBe('');
    expect(sheetsBatchGet).not.toHaveBeenCalled();
  });

  it('handles sheets with no values (empty grid) cleanly', async () => {
    sheetsGet.mockResolvedValue({
      data: {
        properties: { title: 'WB' },
        sheets: [{ properties: { title: 'Sheet1' } }],
      },
    });
    sheetsBatchGet.mockResolvedValue({
      data: {
        valueRanges: [{ range: 'Sheet1!A1:Z1000' /* no values */ }],
      },
    });
    const text = await extractGoogleSheets('id');
    expect(text).toContain('## Sheet: Sheet1');
    // No rows should appear, but no crash either.
  });
});

// ── PDF vision path (issue C1) ──────────────────────────────────────────────

describe('extractText PDF vision path', () => {
  const pdfFile = () => makeFile({ mimeType: 'application/pdf' });

  it('extracts via vision on the happy path (extractor=vision)', async () => {
    const outcome = await extractText(pdfFile());
    expect(outcome).toMatchObject({
      kind: 'ok',
      extractor: 'vision',
      text: '# Vision Doc\n\n## Page 1\nvision transcription',
    });
    expect((outcome as { contentHash: string }).contentHash).toMatch(/^[0-9a-f]{32}$/);
    // The call carried the PDF as inline base64 document data with the
    // caps + minimal thinking, per the C1 contract.
    expect(llmComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.5-flash',
        temperature: 0,
        media: [
          expect.objectContaining({
            mimeType: 'application/pdf',
            dataBase64: Buffer.from('%PDF-1.4 fake bytes').toString('base64'),
          }),
        ],
        maxOutputTokens: 32768,
        thinkingLevel: 'MINIMAL',
        timeoutMs: 180000,
      }),
    );
  });

  it('falls back to the text-layer path when the vision call throws', async () => {
    llmComplete.mockRejectedValue(new Error('503 model overloaded'));
    const outcome = await extractText(pdfFile());
    expect(outcome).toMatchObject({
      kind: 'ok',
      extractor: 'pdf',
      text: 'text-layer extraction',
    });
  });

  it('falls back when vision returns an empty transcription', async () => {
    llmComplete.mockResolvedValue({ text: '   \n', driver: 'gemini', model: 'm' });
    const outcome = await extractText(pdfFile());
    expect(outcome).toMatchObject({ kind: 'ok', extractor: 'pdf' });
  });

  it('skips vision above the vision size cap but still extracts text', async () => {
    mockConfig.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 4; // smaller than the fake buffer
    const outcome = await extractText(pdfFile());
    expect(outcome).toMatchObject({ kind: 'ok', extractor: 'pdf' });
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('skips vision above the page cap but still extracts text', async () => {
    unpdfGetDocumentProxy.mockResolvedValue({ numPages: 51 });
    const outcome = await extractText(pdfFile());
    expect(outcome).toMatchObject({ kind: 'ok', extractor: 'pdf' });
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('still tries vision when the page count is unknowable (text parser choked)', async () => {
    // A PDF unpdf can't open is exactly where vision may still succeed.
    unpdfGetDocumentProxy.mockRejectedValue(new Error('bad xref'));
    const outcome = await extractText(pdfFile());
    expect(outcome).toMatchObject({ kind: 'ok', extractor: 'vision' });
  });

  it('skips vision when DRIVE_VISION_ENABLED=false', async () => {
    mockConfig.DRIVE_VISION_ENABLED = false;
    const outcome = await extractText(pdfFile());
    expect(outcome).toMatchObject({ kind: 'ok', extractor: 'pdf' });
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('skips vision under the mock LLM driver (stub output must not become "text")', async () => {
    llmDriver.name = 'mock';
    const outcome = await extractText(pdfFile());
    expect(outcome).toMatchObject({ kind: 'ok', extractor: 'pdf' });
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('propagates the text-layer error when vision fails AND the fallback fails', async () => {
    // A vision failure must never fail the scan on its own — but when the
    // fallback also fails, that's a genuine extraction failure and keeps
    // the existing throw-to-sync behavior.
    llmComplete.mockRejectedValue(new Error('vision down'));
    unpdfGetDocumentProxy.mockRejectedValue(new Error('bad xref'));
    await expect(extractText(pdfFile())).rejects.toThrow('bad xref');
  });
});

// ── predictExtractionSkip ↔ extractText lockstep ────────────────────────────
// The two functions walk one decision tree; this matrix pins that a
// predicted skip is returned VERBATIM by extractText and a predicted null
// really extracts. The vision branch must stay skip-neutral: PDFs predict
// null whether vision or the text layer ends up producing the text.

describe('predictExtractionSkip ↔ extractText lockstep', () => {
  const DOCX_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const PPTX_MIME =
    'application/vnd.openxmlformats-officedocument.presentationml.presentation';

  const matrix: Array<{ label: string; file: TraversedFile; setup?: () => void }> = [
    { label: 'folder', file: makeFile({ isFolder: true, mimeType: 'application/vnd.google-apps.folder' }) },
    { label: 'unsupported mime (image/png)', file: makeFile({ mimeType: 'image/png' }) },
    { label: 'PDF over the download cap', file: makeFile({ size: 26214401 }) },
    { label: 'PDF within caps (vision on)', file: makeFile({}) },
    {
      label: 'PDF within caps (vision off)',
      file: makeFile({}),
      setup: () => {
        mockConfig.DRIVE_VISION_ENABLED = false;
      },
    },
    {
      label: 'PDF under download cap but over vision cap',
      file: makeFile({}),
      setup: () => {
        mockConfig.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 4;
      },
    },
    { label: 'DOCX', file: makeFile({ mimeType: DOCX_MIME, name: 'f.docx' }) },
    { label: 'PPTX', file: makeFile({ mimeType: PPTX_MIME, name: 'f.pptx' }) },
    { label: 'text/plain', file: makeFile({ mimeType: 'text/plain', name: 'f.txt' }) },
    { label: 'text/plain over the download cap', file: makeFile({ mimeType: 'text/plain', size: 26214401 }) },
    {
      label: 'Google Doc',
      file: makeFile({ mimeType: 'application/vnd.google-apps.document' }),
      setup: () => docsGet.mockResolvedValue({ data: { title: 'Doc', body: { content: [] } } }),
    },
    {
      label: 'Google Slides',
      file: makeFile({ mimeType: 'application/vnd.google-apps.presentation' }),
      setup: () => presentationsGet.mockResolvedValue({ data: { title: 'Deck', slides: [] } }),
    },
    {
      label: 'Google Sheet',
      file: makeFile({ mimeType: 'application/vnd.google-apps.spreadsheet' }),
      setup: () =>
        sheetsGet.mockResolvedValue({
          data: { properties: { title: 'WB' }, sheets: [{ properties: { title: 'S1' } }] },
        }) &&
        sheetsBatchGet.mockResolvedValue({
          data: { valueRanges: [{ range: 'S1!A1:B2', values: [['x']] }] },
        }),
    },
    {
      label: 'shortcut without resolved target',
      file: makeFile({ mimeType: 'application/vnd.google-apps.shortcut' }),
    },
    {
      label: 'shortcut to a folder',
      file: makeFile({
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTarget: { id: 't1', mimeType: 'application/vnd.google-apps.folder' },
      }),
    },
    {
      label: 'shortcut chain',
      file: makeFile({
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTarget: { id: 't1', mimeType: 'application/vnd.google-apps.shortcut' },
      }),
    },
    {
      label: 'shortcut to PDF (unverifiable size)',
      file: makeFile({
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTarget: { id: 't1', mimeType: 'application/pdf' },
      }),
    },
    {
      label: 'shortcut to Google Doc',
      file: makeFile({
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTarget: { id: 't1', mimeType: 'application/vnd.google-apps.document' },
      }),
      setup: () => docsGet.mockResolvedValue({ data: { title: 'Doc', body: { content: [] } } }),
    },
  ];

  for (const { label, file, setup } of matrix) {
    it(`agrees on ${label}`, async () => {
      setup?.();
      const predicted = predictExtractionSkip(file);
      const actual = await extractText(file);
      if (predicted) {
        // Predicted skips must be returned verbatim — same reason AND detail.
        expect(actual).toEqual(predicted);
      } else {
        expect(actual.kind).toBe('ok');
      }
    });
  }
});
