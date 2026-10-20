/**
 * Every Workspace content call and the People lookup goes through its API's
 * pacer — the calls that bypassed every limiter before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  pacedCall: vi.fn(async (_api: string, fn: () => Promise<unknown>) => fn()),
  docsGet: vi.fn(),
  slidesGet: vi.fn(),
  sheetsGet: vi.fn(),
  sheetsBatchGet: vi.fn(),
  peopleGet: vi.fn(),
}));

vi.mock('../pacing', () => ({ pacedCall: m.pacedCall }));
vi.mock('googleapis', () => ({
  google: {
    docs: vi.fn(() => ({ documents: { get: m.docsGet } })),
    slides: vi.fn(() => ({ presentations: { get: m.slidesGet } })),
    sheets: vi.fn(() => ({
      spreadsheets: { get: m.sheetsGet, values: { batchGet: m.sheetsBatchGet } },
    })),
    people: vi.fn(() => ({ people: { get: m.peopleGet } })),
    drive: vi.fn(() => ({})),
  },
}));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn(async () => ({})) }));
vi.mock('../../config', () => ({ config: { DRIVE_READ_TIMEOUT_MS: 60_000 } }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../prisma', () => ({
  prisma: { peopleResourceMap: { findMany: vi.fn(async () => []), upsert: vi.fn() } },
}));

import { extractGoogleDoc, extractGoogleSheets, extractGoogleSlides } from '../extract';
import { resolveActors } from '../../forward/people';

const apis = () => m.pacedCall.mock.calls.map(([api]) => api);

beforeEach(() => {
  m.pacedCall.mockClear();
  m.docsGet.mockResolvedValue({ data: { title: 'D', body: { content: [] } } });
  m.slidesGet.mockResolvedValue({ data: { title: 'S', slides: [] } });
  m.sheetsGet.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Tab' } }] } });
  m.sheetsBatchGet.mockResolvedValue({ data: { valueRanges: [] } });
  m.peopleGet.mockResolvedValue({ data: { emailAddresses: [{ value: 'a@example.com' }] } });
});

describe('Workspace calls are paced per API', () => {
  it('Docs, Slides and both Sheets reads', async () => {
    await extractGoogleDoc('d1');
    await extractGoogleSlides('s1');
    await extractGoogleSheets('x1');
    expect(apis()).toEqual(['docs', 'slides', 'sheets', 'sheets']);
  });

  it('People lookups', async () => {
    await resolveActors(new Set(['people/1']));
    expect(apis()).toEqual(['people']);
  });
});
