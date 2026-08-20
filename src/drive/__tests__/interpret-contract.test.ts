/**
 * interpret-contract.test.ts — the extraction↔interpret contract (C3 / #36).
 *
 * Two halves:
 *
 * 1. MARKER GRAMMAR (contract): extraction text — whatever produced it — must
 *    satisfy the single grammar in extract-markers.ts. We pin BOTH producers:
 *    the Google-native walkers (run for real over mocked API responses, same
 *    scaffolding as extract.test.ts) and vision-shaped transcriptions (fixtures
 *    shaped exactly like VISION_PROMPT / VISION_IMAGE_PROMPT output — the
 *    prompts instruct an LLM, so its output can't be produced hermetically).
 *    Producer drift (a walker emitting a marker the grammar doesn't know)
 *    breaks this test instead of silently degrading the consumer prompts.
 *
 * 2. CONSUMER SPOT-CHECK (no regressions on plain text): the two consumers of
 *    extraction text keep their exact pre-C3 behavior on a plain-text file —
 *    the roadmap's "no interpret regressions on a text-file spot-check".
 *      - idea-extraction: in-code prompt carries the shared grammar note and
 *        the file text verbatim; the strict deck-type gate still drops ideas
 *        from deck_type='other' responses.
 *      - interpret: runs against a runPreset stub that behaves exactly like
 *        the mock LLM driver (schema-shaped empty instance), because the real
 *        drive.file_extraction.v1 template is a DB row (D15) — only the
 *        code-side contract (variables in, parse/validate out) is testable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Type, type Schema } from '@google/genai';

// ── Hoisted mocks (same boundaries as extract.test.ts) ──────────────────────

const {
  googleMock,
  buildBotOAuthClientMock,
  docsGet,
  presentationsGet,
  sheetsGet,
  sheetsBatchGet,
} = vi.hoisted(() => ({
  googleMock: { docs: vi.fn(), slides: vi.fn(), sheets: vi.fn() },
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
    drive: vi.fn(() => ({})),
    auth: { OAuth2: vi.fn() },
  },
}));

vi.mock('../../workspace', () => ({
  buildBotOAuthClient: buildBotOAuthClientMock,
}));

const { mockConfig, CONFIG_DEFAULTS } = vi.hoisted(() => {
  const CONFIG_DEFAULTS = { GEMINI_MAX_INPUT_CHARS: 40000 };
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

// Mocking '../../ai' keeps the prisma-importing preset service out of the
// unit suite (hermeticity). SchemaType must be the REAL enum — the module
// under test builds response schemas from it at import time.
const { llmComplete, runPresetMock } = vi.hoisted(() => ({
  llmComplete: vi.fn(),
  runPresetMock: vi.fn(),
}));

vi.mock('../../ai', async () => {
  const genai = await vi.importActual<typeof import('@google/genai')>('@google/genai');
  return {
    defaultLlm: { name: 'gemini', complete: llmComplete },
    DEFAULT_GEMINI_MODEL: 'gemini-3.5-flash',
    SchemaType: genai.Type,
    runPreset: runPresetMock,
    // The stubs below return clean JSON; the real fence-tolerant parser
    // lives in prompt-preset.service (not under test here).
    parseLlmJson: (raw: string) => JSON.parse(raw),
  };
});

import { extractGoogleDoc, extractGoogleSlides, extractGoogleSheets } from '../extract';
import {
  SECTION_MARKER,
  SPEAKER_NOTES_MARKER,
  TITLE_MARKER,
  VISUAL_DESCRIPTION_MARKER,
  MARKER_GRAMMAR_PROMPT_NOTE,
  findMarkerGrammarViolations,
} from '../extract-markers';
import { extractIdeasFromFile } from '../idea-extraction';
import { interpretFile } from '../interpret';
import type { AccountCurrentState } from '../schema';
import type { TraversedFile } from '../types';

beforeEach(() => {
  Object.assign(mockConfig, CONFIG_DEFAULTS);
  buildBotOAuthClientMock.mockReset();
  buildBotOAuthClientMock.mockResolvedValue({});
  docsGet.mockReset();
  presentationsGet.mockReset();
  sheetsGet.mockReset();
  sheetsBatchGet.mockReset();
  googleMock.docs.mockReturnValue({ documents: { get: docsGet } });
  googleMock.slides.mockReturnValue({ presentations: { get: presentationsGet } });
  googleMock.sheets.mockReturnValue({
    spreadsheets: { get: sheetsGet, values: { batchGet: sheetsBatchGet } },
  });
  llmComplete.mockReset();
  runPresetMock.mockReset();
});

function makeFile(overrides: Partial<TraversedFile>): TraversedFile {
  return {
    id: 'file-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    path: 'Acme / Q3 / notes.txt',
    modifiedTime: null,
    modifiedByEmail: null,
    createdTime: null,
    size: 1024,
    isFolder: false,
    ...overrides,
  };
}

// ── 1. Marker grammar: producers conform ────────────────────────────────────

describe('extraction marker grammar (extract-markers.ts contract)', () => {
  it('native Slides output satisfies the grammar (## Slide N, ### Speaker notes, tables)', async () => {
    presentationsGet.mockResolvedValue({
      data: {
        title: 'Acme Q3 Pitch',
        slides: [
          {
            pageElements: [
              { shape: { text: { textElements: [{ textRun: { content: 'Welcome\n' } }] } } },
              {
                table: {
                  tableRows: [
                    {
                      tableCells: [
                        { text: { textElements: [{ textRun: { content: 'A1' } }] } },
                        { text: { textElements: [{ textRun: { content: 'B1' } }] } },
                      ],
                    },
                  ],
                },
              },
            ],
            slideProperties: {
              notesPage: {
                pageElements: [
                  { shape: { text: { textElements: [{ textRun: { content: 'a note' } }] } } },
                ],
              },
            },
          },
          {
            pageElements: [
              { shape: { text: { textElements: [{ textRun: { content: 'Goals\n' } }] } } },
            ],
          },
        ],
      },
    });

    const text = await extractGoogleSlides('pres-id');
    expect(findMarkerGrammarViolations(text)).toEqual([]);
    expect(text.split('\n')[0]).toMatch(TITLE_MARKER);
    expect('## Slide 1').toMatch(SECTION_MARKER);
    expect(text).toContain('## Slide 1');
    expect(text).toContain('## Slide 2');
    expect(text).toContain('### Speaker notes');
    expect(text).toContain('A1\tB1');
  });

  it('native Sheets output satisfies the grammar (## Sheet: <name>, tab rows)', async () => {
    sheetsGet.mockResolvedValue({
      data: {
        properties: { title: 'Q3 Plan' },
        sheets: [{ properties: { title: 'Forecast', sheetId: 0 } }],
      },
    });
    sheetsBatchGet.mockResolvedValue({
      data: {
        valueRanges: [
          {
            range: 'Forecast!A1:Z9',
            values: [
              ['Month', 'Revenue'],
              ['Jan', '$100k'],
            ],
          },
        ],
      },
    });

    const text = await extractGoogleSheets('ssheet-id');
    expect(findMarkerGrammarViolations(text)).toEqual([]);
    expect(text).toContain('## Sheet: Forecast');
    expect('## Sheet: Forecast').toMatch(SECTION_MARKER);
    expect(text).toContain('Jan\t$100k');
  });

  it('native Docs output satisfies the grammar (# title, flat paragraphs)', async () => {
    docsGet.mockResolvedValue({
      data: {
        title: 'Q3 Launch Brief',
        body: {
          content: [
            { paragraph: { elements: [{ textRun: { content: 'Primary contact: Bob\n' } }] } },
          ],
        },
      },
    });

    const text = await extractGoogleDoc('doc-id');
    expect(findMarkerGrammarViolations(text)).toEqual([]);
    expect(text.split('\n')[0]).toMatch(TITLE_MARKER);
  });

  it('vision PDF transcription shape satisfies the grammar (## Page N + [Chart: …])', () => {
    // Shaped exactly like VISION_PROMPT output (extract-vision.ts).
    const visionPdf = [
      '# Acme Q3 Pitch',
      '',
      '## Page 1',
      'Welcome to Q3',
      '[Chart: monthly revenue by region, peaks in March]',
      '',
      '## Page 2',
      'Month\tRevenue',
      'Jan\t$100k',
      '[Poster: product bottle on a yellow field, bold retro typography]',
    ].join('\n');

    expect(findMarkerGrammarViolations(visionPdf)).toEqual([]);
    expect('## Page 1').toMatch(SECTION_MARKER);
    expect('[Chart: monthly revenue by region, peaks in March]').toMatch(VISUAL_DESCRIPTION_MARKER);
  });

  it('vision image transcription shape satisfies the grammar (# headline + [Poster: …])', () => {
    // Shaped exactly like VISION_IMAGE_PROMPT output (extract-vision.ts).
    const visionImage = [
      '# Taste the Sun',
      'Limited summer edition — in stores June 1',
      '[Poster: product bottle on a yellow field, bold retro typography]',
      'Logo: Acme sunburst lockup, bottom right',
    ].join('\n');

    expect(findMarkerGrammarViolations(visionImage)).toEqual([]);
    expect(visionImage.split('\n')[0]).toMatch(TITLE_MARKER);
  });

  it('flags marker-shaped lines that are NOT in the grammar', () => {
    const drifted = ['## Pg 3', '### Notes', '## Slide 1', '### Speaker notes'].join('\n');
    expect(findMarkerGrammarViolations(drifted)).toEqual(['## Pg 3', '### Notes']);
    expect('## Pg 3').not.toMatch(SECTION_MARKER);
    expect('### Notes').not.toMatch(SPEAKER_NOTES_MARKER);
  });
});

// ── 2a. idea-extraction spot-check (plain text — no regressions) ────────────

describe('idea-extraction over plain text (spot-check)', () => {
  const PLAIN_TEXT = [
    'Concept round for the Acme summer brief.',
    'Idea one: Golden Hour — a social-first campaign leaning on sunset UGC.',
    'Idea two: Sunburst Stories — retro print series with illustrated bottles.',
  ].join('\n');

  const file = makeFile({ name: 'Acme R1 Concepts.txt', path: 'Acme / Pitch / R1 Concepts.txt' });

  it('sends the file text verbatim and carries the shared marker-grammar note', async () => {
    llmComplete.mockResolvedValue({
      text: JSON.stringify({ deck_type: 'other', ideas: [] }),
      driver: 'gemini',
      model: 'gemini-3.5-flash',
    });

    await extractIdeasFromFile({ file, text: PLAIN_TEXT, accountName: 'Acme' });

    expect(llmComplete).toHaveBeenCalledTimes(1);
    const prompt = (llmComplete.mock.calls[0]![0] as { prompt: string }).prompt;
    // Plain text rides through UNCHANGED between the """ fences.
    expect(prompt).toContain(`"""\n${PLAIN_TEXT}\n"""`);
    // Vision-awareness (C3): the ONE shared grammar note, verbatim.
    expect(prompt).toContain(MARKER_GRAMMAR_PROMPT_NOTE);
    // The strict deck-type gate is still worded as before — not loosened.
    expect(prompt).toContain('Everything else is "other" → deck_type="other" and ideas=[]');
    expect(prompt).toContain('Better to miss than to invent');
  });

  it('still normalizes ideas from a pitch response (behavior unchanged)', async () => {
    llmComplete.mockResolvedValue({
      text: JSON.stringify({
        deck_type: 'pitch',
        ideas: [
          { name: '  Golden Hour ', facets: [' social-first campaign ', '', 'sunset UGC hook'] },
          { name: '  ', facets: ['dropped — empty name'] },
        ],
      }),
      driver: 'gemini',
      model: 'gemini-3.5-flash',
    });

    const result = await extractIdeasFromFile({ file, text: PLAIN_TEXT, accountName: 'Acme' });
    expect(result).toEqual({
      deckType: 'pitch',
      ideas: [{ name: 'Golden Hour', facets: ['social-first campaign', 'sunset UGC hook'] }],
    });
  });

  it('the deck-type gate still WINS: other + ideas → no ideas', async () => {
    llmComplete.mockResolvedValue({
      text: JSON.stringify({
        deck_type: 'other',
        ideas: [{ name: 'Should be dropped', facets: ['the gate wins'] }],
      }),
      driver: 'gemini',
      model: 'gemini-3.5-flash',
    });

    const result = await extractIdeasFromFile({ file, text: PLAIN_TEXT, accountName: 'Acme' });
    expect(result).toEqual({ deckType: 'other', ideas: [] });
  });
});

// ── 2b. interpret spot-check (mock-driver shape — plain text) ───────────────

/**
 * Replica of MockLlmDriver.emptyInstance (gemini.client.ts): a minimally-
 * valid instance of the responseSchema. Keeping the stub derived from the
 * SCHEMA (not hand-written JSON) pins that the mock driver's real dev-mode
 * output still parses through interpretFile's Zod after any schema change.
 */
function emptyInstance(schema: Schema): unknown {
  switch (schema.type) {
    case Type.ARRAY:
      return [];
    case Type.OBJECT: {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of schema.required ?? []) {
        const child = props[key];
        if (child) out[key] = emptyInstance(child);
      }
      return out;
    }
    case Type.STRING:
      return '';
    case Type.NUMBER:
    case Type.INTEGER:
      return 0;
    case Type.BOOLEAN:
      return false;
    default:
      return null;
  }
}

describe('interpret over plain text via the mock-driver shape (spot-check)', () => {
  const PLAIN_TEXT = 'Kickoff notes: launch shifted to June 1. Maya is creative lead.';

  function interpretInput(text: string) {
    return {
      file: makeFile({ name: 'kickoff.txt', path: 'Acme / kickoff.txt' }),
      text,
      accountName: 'Acme',
      accountCurrentState: {} as AccountCurrentState,
      campaignName: null,
      campaignCurrentState: null,
      knownCampaigns: ['Summer Launch'],
    };
  }

  beforeEach(() => {
    runPresetMock.mockImplementation(async (opts: { responseSchema?: Schema }) => ({
      text: JSON.stringify(opts.responseSchema ? emptyInstance(opts.responseSchema) : []),
      driver: 'mock',
      model: 'gemini-3.5-flash',
      prompt: '(rendered by preset)',
    }));
  });

  it('passes plain file text through to the preset UNCHANGED (no truncation)', async () => {
    await interpretFile(interpretInput(PLAIN_TEXT));

    expect(runPresetMock).toHaveBeenCalledTimes(1);
    const opts = runPresetMock.mock.calls[0]![0] as {
      key: string;
      variables: Record<string, unknown>;
    };
    expect(opts.key).toBe('drive.file_extraction.v1');
    expect(opts.variables['file_text']).toBe(PLAIN_TEXT);
  });

  it('parses the mock-driver stub: empty observations, deck_type falls back to other', async () => {
    const result = await interpretFile(interpretInput(PLAIN_TEXT));
    // emptyInstance emits deck_type:'' — an invalid enum value that the
    // .catch('other') in PerFileResponseSchema must absorb, exactly as the
    // real mock driver's dev-mode output does.
    expect(result).toEqual({
      account: [],
      campaign: [],
      deckType: 'other',
      truncated: false,
      driver: 'mock',
    });
  });

  it('still truncates once at GEMINI_MAX_INPUT_CHARS (unchanged by C3)', async () => {
    mockConfig.GEMINI_MAX_INPUT_CHARS = 10;
    const result = await interpretFile(interpretInput(PLAIN_TEXT));

    expect(result.truncated).toBe(true);
    const opts = runPresetMock.mock.calls[0]![0] as { variables: Record<string, unknown> };
    const sent = opts.variables['file_text'] as string;
    expect(sent.startsWith(PLAIN_TEXT.slice(0, 10))).toBe(true);
    expect(sent).toContain(`[TRUNCATED: ${PLAIN_TEXT.length - 10} chars omitted]`);
  });
});
