import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('../../prisma', () => ({ prisma: { driveSyncRun: { findFirst } } }));

import { config } from '../../config';
import {
  CUTOFF_SKEW_MS,
  binaryContentHash,
  contentHashFor,
  contentZone,
  gateCutoff,
  textContentHash,
} from '../content-gate';
import type { EntityAttribution } from '../../drive/structure';
import type { TraversedFile } from '../../drive/types';

const ACCOUNT: EntityAttribution = {
  ownerType: 'account',
  campaignFolderId: null,
  campaignName: null,
  matchedCampaignId: null,
  campaignStatus: null,
  pieceId: null,
  pieceName: null,
  pieceFolderId: null,
};
const CAMPAIGN: EntityAttribution = {
  ...ACCOUNT,
  ownerType: 'campaign',
  campaignFolderId: 'folder-q3',
  campaignName: 'Q3 Launch',
  matchedCampaignId: null,
  campaignStatus: 'new',
};

function f(over: Partial<TraversedFile> = {}): TraversedFile {
  return {
    id: 'f1',
    name: 'brief',
    mimeType: 'application/vnd.google-apps.document',
    path: 'Acme / Briefs / brief',
    modifiedTime: '2026-09-20T10:00:00.000Z',
    modifiedByEmail: 'editor@example.com',
    createdTime: null,
    size: null,
    isFolder: false,
    ...over,
  };
}

const zone = contentZone(ACCOUNT);
const MAX = config.GEMINI_MAX_INPUT_CHARS;
const setMax = (n: number) => {
  (config as { GEMINI_MAX_INPUT_CHARS: number }).GEMINI_MAX_INPUT_CHARS = n;
};

beforeEach(() => setMax(MAX));

describe('contentZone', () => {
  it('changes when the campaign gets matched to a row, not only with its folder', () => {
    expect(contentZone({ ...CAMPAIGN, matchedCampaignId: 'camp-q3' })).not.toBe(
      contentZone(CAMPAIGN),
    );
    expect(contentZone({ ...CAMPAIGN, pieceId: 'piece-1' })).not.toBe(contentZone(CAMPAIGN));
    expect(contentZone(CAMPAIGN)).not.toBe(contentZone(ACCOUNT));
  });
});

describe('textContentHash', () => {
  it('is versioned and stable for the same inputs', () => {
    const h = textContentHash('brief text', f(), zone, false);
    expect(h).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(textContentHash('brief text', f(), zone, false)).toBe(h);
  });

  it('changes with the text, the name, the path, the zone and the ideas flag', () => {
    const h = textContentHash('brief text', f(), zone, false);
    expect(textContentHash('brief text!', f(), zone, false)).not.toBe(h);
    expect(textContentHash('brief text', f({ name: 'brief v2' }), zone, false)).not.toBe(h);
    expect(textContentHash('brief text', f({ path: 'Acme / Old / brief' }), zone, false)).not.toBe(
      h,
    );
    expect(textContentHash('brief text', f(), contentZone(CAMPAIGN), false)).not.toBe(h);
    expect(textContentHash('brief text', f(), zone, true)).not.toBe(h);
  });

  it('ignores the modified time and editor: an edit that changed nothing else still matches', () => {
    const h = textContentHash('brief text', f(), zone, false);
    expect(
      textContentHash('brief text', f({ modifiedTime: '2026-10-01T00:00:00.000Z' }), zone, false),
    ).toBe(h);
    expect(
      textContentHash('brief text', f({ modifiedByEmail: 'other@example.com' }), zone, false),
    ).toBe(h);
  });

  it('ideas tier off: an edit past the prompt cut matches, even one that changes the length', () => {
    const head = 'a'.repeat(MAX);
    expect(textContentHash(`${head}tail one`, f(), zone, false)).toBe(
      textContentHash(`${head}a much longer second tail`, f(), zone, false),
    );
  });

  it('ideas tier on: an edit past the cut does NOT match (idea extraction reads all of it)', () => {
    const head = 'a'.repeat(MAX);
    expect(textContentHash(`${head}tail one`, f(), zone, true)).not.toBe(
      textContentHash(`${head}tail two`, f(), zone, true),
    );
  });

  it('still sees whether the text was cut at all', () => {
    const head = 'a'.repeat(MAX);
    expect(textContentHash(head, f(), zone, false)).not.toBe(
      textContentHash(`${head}x`, f(), zone, false),
    );
  });
});

describe('binaryContentHash', () => {
  const pdf = (over: Partial<TraversedFile> = {}) =>
    f({ mimeType: 'application/pdf', name: 'deck.pdf', path: 'Acme / deck.pdf', ...over });

  it('hashes the md5 of a downloaded file with its name, path, zone and ideas flag', () => {
    const h = binaryContentHash(pdf({ md5Checksum: 'abc', version: '3' }), zone, false);
    expect(h).toMatch(/^bin:[0-9a-f]{64}$/);
    // md5 wins: a metadata-only change bumps version and head revision, not md5.
    expect(
      binaryContentHash(
        pdf({ md5Checksum: 'abc', version: '4', headRevisionId: 'r2' }),
        zone,
        false,
      ),
    ).toBe(h);
    expect(binaryContentHash(pdf({ md5Checksum: 'abd', version: '3' }), zone, false)).not.toBe(h);
    expect(
      binaryContentHash(pdf({ md5Checksum: 'abc', name: 'deck-v2.pdf' }), zone, false),
    ).not.toBe(h);
    expect(binaryContentHash(pdf({ md5Checksum: 'abc' }), zone, true)).not.toBe(
      binaryContentHash(pdf({ md5Checksum: 'abc' }), zone, false),
    );
  });

  it('falls back to the head revision, then to version, when Drive gave no md5', () => {
    const byRev = binaryContentHash(pdf({ headRevisionId: 'r1', version: '3' }), zone, false);
    expect(byRev).toMatch(/^bin:/);
    // With a head revision, a version bump (metadata) does not change the hash.
    expect(binaryContentHash(pdf({ headRevisionId: 'r1', version: '4' }), zone, false)).toBe(byRev);
    expect(binaryContentHash(pdf({ headRevisionId: 'r2', version: '3' }), zone, false)).not.toBe(
      byRev,
    );
    expect(binaryContentHash(pdf({ version: '3' }), zone, false)).not.toBe(
      binaryContentHash(pdf({ version: '4' }), zone, false),
    );
  });

  it('covers the prompt cut: raising GEMINI_MAX_INPUT_CHARS re-reads a downloaded file', () => {
    const h = binaryContentHash(pdf({ md5Checksum: 'abc' }), zone, false);
    setMax(MAX * 2);
    expect(binaryContentHash(pdf({ md5Checksum: 'abc' }), zone, false)).not.toBe(h);
  });

  it('is null for Google-native files, shortcuts and files without a marker', () => {
    expect(binaryContentHash(f({ md5Checksum: 'abc' }), zone, false)).toBeNull();
    expect(
      binaryContentHash(
        pdf({ md5Checksum: 'abc', shortcutTarget: { id: 't', mimeType: 'application/pdf' } }),
        zone,
        false,
      ),
    ).toBeNull();
    expect(binaryContentHash(pdf(), zone, false)).toBeNull();
  });
});

describe('contentHashFor', () => {
  it('prefers the binary form, else the text form', () => {
    expect(
      contentHashFor(f({ mimeType: 'text/plain', md5Checksum: 'x' }), 'hi', zone, false),
    ).toMatch(/^bin:/);
    expect(contentHashFor(f({ mimeType: 'text/plain' }), 'hi', zone, false)).toMatch(/^v2:/);
    expect(contentHashFor(f(), 'hi', zone, false)).toMatch(/^v2:/);
  });
});

describe('gateCutoff', () => {
  it('the account last completed run, less the clock-skew margin', async () => {
    findFirst.mockResolvedValue({ completedAt: new Date('2026-10-20T12:00:00.000Z') });
    const cutoff = await gateCutoff('acct-1');
    expect(cutoff).toEqual(new Date(Date.parse('2026-10-20T12:00:00.000Z') - CUTOFF_SKEW_MS));
    expect(findFirst).toHaveBeenCalledWith({
      where: { accountId: 'acct-1', status: 'completed', completedAt: { not: null } },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    });
  });

  it('null before the first completed run', async () => {
    findFirst.mockResolvedValue(null);
    expect(await gateCutoff('acct-1')).toBeNull();
  });
});
