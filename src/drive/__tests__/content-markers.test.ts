import { describe, expect, it, vi } from 'vitest';

// The client module loads googleapis, the bot credential and config at import;
// none of them is exercised here.
vi.mock('googleapis', () => ({ google: { drive: () => ({}) } }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: async () => ({}) }));
const cfg = vi.hoisted(() => ({
  DRIVE_READ_TIMEOUT_MS: 60_000,
  DRIVE_MEDIA_TIMEOUT_MS: 300_000,
  SKIP_UNCHANGED_CONTENT: 'off' as 'off' | 'on',
}));
vi.mock('../../config', () => ({ config: cfg }));

const { FILE_FIELDS, fileFields, flatFileFields } = await import('../client');
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

describe('fileFields', () => {
  const MARKERS = ['version', 'md5Checksum', 'headRevisionId', 'trashed'];

  it('flag off: exactly the request before the gate', () => {
    cfg.SKIP_UNCHANGED_CONTENT = 'off';
    expect(fileFields()).toBe(FILE_FIELDS);
    for (const f of MARKERS) expect(FILE_FIELDS.split(',')).not.toContain(f);
    // The flat listing kept its own two markers before the gate.
    expect(flatFileFields()).toBe(`${FILE_FIELDS},version,md5Checksum`);
  });

  it('flag on: every listing and files.get ask for the four markers, each once', () => {
    cfg.SKIP_UNCHANGED_CONTENT = 'on';
    for (const fields of [fileFields(), flatFileFields()]) {
      const list = fields.split(',');
      for (const f of MARKERS) expect(list).toContain(f);
      expect(new Set(list).size).toBe(list.length);
    }
    cfg.SKIP_UNCHANGED_CONTENT = 'off';
  });
});
