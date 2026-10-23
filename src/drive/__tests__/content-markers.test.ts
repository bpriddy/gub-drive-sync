import { describe, expect, it, vi } from 'vitest';

// The client module loads googleapis, the bot credential and config at import;
// none of them is exercised here.
vi.mock('googleapis', () => ({ google: { drive: () => ({}) } }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: async () => ({}) }));
vi.mock('../../config', () => ({
  config: { DRIVE_READ_TIMEOUT_MS: 60_000, DRIVE_MEDIA_TIMEOUT_MS: 300_000 },
}));

const { FILE_FIELDS, FLAT_FILE_FIELDS } = await import('../client');
const { contentMarkers } = await import('../file-markers');

describe('contentMarkers', () => {
  it('copies the markers Drive returned', () => {
    expect(
      contentMarkers({
        id: 'f1',
        version: '42',
        md5Checksum: 'abc123',
        headRevisionId: 'rev-9',
        trashed: false,
      }),
    ).toEqual({ version: '42', md5Checksum: 'abc123', headRevisionId: 'rev-9', trashed: false });
  });

  it('omits what Drive did not return: a Google-native file has no md5 or head revision', () => {
    expect(contentMarkers({ id: 'doc', version: '7', trashed: true })).toEqual({
      version: '7',
      trashed: true,
    });
    expect(contentMarkers({ id: 'bare' })).toEqual({});
  });
});

describe('FILE_FIELDS', () => {
  it('requests the four content markers', () => {
    const fields = FILE_FIELDS.split(',');
    for (const f of ['version', 'md5Checksum', 'headRevisionId', 'trashed']) {
      expect(fields).toContain(f);
    }
  });

  it('the flat listing asks for each field once', () => {
    const fields = FLAT_FILE_FIELDS.split(',');
    expect(new Set(fields).size).toBe(fields.length);
  });
});
