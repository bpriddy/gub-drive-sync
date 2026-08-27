/**
 * Unit tests for the per-MIME walkers in drive.extract.ts.
 *
 * Each walker is tested against representative API response shapes (the
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

vi.mock('../../config', () => ({
  config: { DRIVE_MAX_FILE_SIZE_BYTES: 26214400 },
}));

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../client', () => ({
  downloadFileBuffer: vi.fn(),
}));

beforeEach(() => {
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
});

import {
  extractGoogleDoc,
  extractGoogleSlides,
  extractGoogleSheets,
} from '../extract';

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
