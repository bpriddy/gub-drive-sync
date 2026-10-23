import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

import { config } from '../../config';
import { binaryContentHash, contentHashFor, contentZone, textContentHash } from '../content-gate';
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
  matchedCampaignId: 'camp-q3',
  campaignStatus: 'existing',
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

describe('textContentHash', () => {
  it('is versioned and stable for the same text, name, path and zone', () => {
    const h = textContentHash('brief text', f(), zone);
    expect(h).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(textContentHash('brief text', f(), zone)).toBe(h);
  });

  it('changes with the text, the name, the path and the zone', () => {
    const h = textContentHash('brief text', f(), zone);
    expect(textContentHash('brief text!', f(), zone)).not.toBe(h);
    expect(textContentHash('brief text', f({ name: 'brief v2' }), zone)).not.toBe(h);
    expect(textContentHash('brief text', f({ path: 'Acme / Old / brief' }), zone)).not.toBe(h);
    expect(textContentHash('brief text', f(), contentZone(CAMPAIGN))).not.toBe(h);
  });

  it('ignores the modified time and editor: an edit that changed nothing else still matches', () => {
    expect(
      textContentHash('brief text', f({ modifiedTime: '2026-10-01T00:00:00.000Z' }), zone),
    ).toBe(textContentHash('brief text', f(), zone));
    expect(textContentHash('brief text', f({ modifiedByEmail: 'other@example.com' }), zone)).toBe(
      textContentHash('brief text', f(), zone),
    );
  });

  it('ignores an edit past the prompt cut, even one that changes the length', () => {
    const head = 'a'.repeat(MAX);
    expect(textContentHash(`${head}tail one`, f(), zone)).toBe(
      textContentHash(`${head}a much longer second tail`, f(), zone),
    );
  });

  it('still sees whether the text was cut at all', () => {
    const head = 'a'.repeat(MAX);
    expect(textContentHash(head, f(), zone)).not.toBe(textContentHash(`${head}x`, f(), zone));
  });
});

describe('binaryContentHash', () => {
  const pdf = (over: Partial<TraversedFile> = {}) =>
    f({ mimeType: 'application/pdf', name: 'deck.pdf', path: 'Acme / deck.pdf', ...over });

  it('hashes the md5 of a downloaded file with its name, path and zone', () => {
    const h = binaryContentHash(pdf({ md5Checksum: 'abc', version: '3' }), zone);
    expect(h).toMatch(/^bin:[0-9a-f]{64}$/);
    // md5 wins over version: a metadata-only change bumps version, not md5.
    expect(binaryContentHash(pdf({ md5Checksum: 'abc', version: '4' }), zone)).toBe(h);
    expect(binaryContentHash(pdf({ md5Checksum: 'abd', version: '3' }), zone)).not.toBe(h);
    expect(binaryContentHash(pdf({ md5Checksum: 'abc', name: 'deck-v2.pdf' }), zone)).not.toBe(h);
  });

  it('falls back to version when Drive gave no md5', () => {
    expect(binaryContentHash(pdf({ version: '3' }), zone)).toMatch(/^bin:/);
    expect(binaryContentHash(pdf({ version: '3' }), zone)).not.toBe(
      binaryContentHash(pdf({ version: '4' }), zone),
    );
  });

  it('is null for Google-native files, shortcuts and files without a marker', () => {
    expect(binaryContentHash(f({ md5Checksum: 'abc' }), zone)).toBeNull();
    expect(
      binaryContentHash(
        pdf({ md5Checksum: 'abc', shortcutTarget: { id: 't', mimeType: 'application/pdf' } }),
        zone,
      ),
    ).toBeNull();
    expect(binaryContentHash(pdf(), zone)).toBeNull();
  });
});

describe('contentHashFor', () => {
  it('prefers the binary form, else the text form', () => {
    expect(contentHashFor(f({ mimeType: 'text/plain', md5Checksum: 'x' }), 'hi', zone)).toMatch(
      /^bin:/,
    );
    expect(contentHashFor(f({ mimeType: 'text/plain' }), 'hi', zone)).toMatch(/^v2:/);
    expect(contentHashFor(f(), 'hi', zone)).toMatch(/^v2:/);
  });
});
