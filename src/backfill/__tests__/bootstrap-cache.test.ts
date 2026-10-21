/**
 * The bootstrap files cache (accounts.drive_bootstrap_files): on-disk format
 * version 2 (each file stored once, days list ids), the decoder that still
 * reads the legacy format, and the lazy single-column read.
 *
 * Prisma is mocked: what is pinned here is the shape that goes to / comes
 * from the column, and which columns a read asks for. The same shapes against
 * a real Postgres (sizes, the 400k-file path) are in bootstrap-cache.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraversedFile } from '../../drive/types';

const { prismaMock, logMock } = vi.hoisted(() => ({
  prismaMock: { account: { update: vi.fn(), findUnique: vi.fn() } },
  logMock: vi.fn(),
}));

vi.mock('../../prisma', () => ({ prisma: prismaMock }));
vi.mock('../../scan/output', () => ({ log: logMock }));

import {
  decodeBootstrapFilesCache,
  encodeBootstrapFilesCache,
  groupFilesByDate,
  loadBootstrapFilesCache,
  persistBootstrapFilesCache,
  persistCursor,
  persistStructureCache,
  type StructureCache,
} from '../days';

function file(n: number, over: Partial<TraversedFile> = {}): TraversedFile {
  return {
    id: `file-${n}`,
    name: `Acme brief ${n}.pdf`,
    mimeType: 'application/pdf',
    parents: ['folder-1'],
    path: `Acme / Briefs / Acme brief ${n}.pdf`,
    modifiedTime: '2024-03-01T10:00:00.000Z',
    modifiedByEmail: `user${n}@example.com`,
    createdTime: '2024-02-01T10:00:00.000Z',
    size: 1000 + n,
    isFolder: false,
    ...over,
  };
}

/** What a column read hands back: fresh objects, none shared with the writer's. */
const throughJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

beforeEach(() => {
  prismaMock.account.update.mockReset();
  prismaMock.account.findUnique.mockReset();
  logMock.mockReset();
});

describe('encodeBootstrapFilesCache', () => {
  // Three days, two files on the first one.
  const files = [
    file(1, { modifiedTime: '2024-03-01T10:00:00.000Z' }),
    file(2, { modifiedTime: '2024-03-02T10:00:00.000Z' }),
    file(3, { modifiedTime: '2024-03-01T18:00:00.000Z' }),
    file(4, { modifiedTime: '2024-03-03T10:00:00.000Z' }),
  ];
  const cache = { files, activeDates: groupFilesByDate(files) };

  it('writes version 2: days carry file ids, not copies of the files', () => {
    const encoded = encodeBootstrapFilesCache(cache);
    expect(encoded.version).toBe(2);
    expect(encoded.files).toEqual(files);
    expect(encoded.activeDates).toEqual([
      { date: '2024-03-01', fileIds: ['file-1', 'file-3'] },
      { date: '2024-03-02', fileIds: ['file-2'] },
      { date: '2024-03-03', fileIds: ['file-4'] },
    ]);
  });

  it('stores every file once — the legacy shape stored it twice', () => {
    const v2 = JSON.stringify(encodeBootstrapFilesCache(cache));
    // What the previous writer produced for the very same cache.
    const legacy = JSON.stringify({ files: cache.files, activeDates: cache.activeDates });
    for (const f of files) {
      // The e-mail is unique per fixture file (the name also sits in its path).
      const marker = JSON.stringify(f.modifiedByEmail);
      expect(occurrences(v2, marker)).toBe(1);
      expect(occurrences(legacy, marker)).toBe(2);
    }
    expect(v2.length).toBeLessThan(legacy.length * 0.65);
  });
});

describe('decodeBootstrapFilesCache — version 2', () => {
  const a = file(1);
  const b = file(2);
  const c = file(3);
  const d = file(4);

  it('hands every day the SAME objects as `files` (one object per file in memory)', () => {
    const raw = throughJson({
      version: 2,
      files: [a, b, c, d],
      activeDates: [
        { date: '2024-03-01', fileIds: [a.id, c.id] },
        { date: '2024-03-02', fileIds: [b.id] },
      ],
    });
    const decoded = decodeBootstrapFilesCache(raw)!;
    expect(decoded.files).toHaveLength(4);
    expect(decoded.activeDates[0]!.files[0]).toBe(decoded.files[0]);
    expect(decoded.activeDates[0]!.files[1]).toBe(decoded.files[2]);
    expect(decoded.activeDates[1]!.files[0]).toBe(decoded.files[1]);
    expect(decoded.activeDates[0]!.files[0]).toEqual(a);
    expect(logMock).not.toHaveBeenCalled();
  });

  it('keeps the order inside a day and the order of the days as stored', () => {
    // A --newest-first chain stores its days descending, and a day's order is
    // the order files were bucketed in — neither is the order of `files`.
    const raw = throughJson({
      version: 2,
      files: [a, b, c, d],
      activeDates: [
        { date: '2024-03-02', fileIds: [d.id, b.id] },
        { date: '2024-03-01', fileIds: [c.id, a.id] },
      ],
    });
    const decoded = decodeBootstrapFilesCache(raw)!;
    expect(decoded.activeDates.map((day) => day.date)).toEqual(['2024-03-02', '2024-03-01']);
    expect(decoded.activeDates[0]!.files.map((f) => f.id)).toEqual([d.id, b.id]);
    expect(decoded.activeDates[1]!.files.map((f) => f.id)).toEqual([c.id, a.id]);
  });

  it('round-trips: encode → column → decode gives back what the run had', () => {
    const files = [
      file(1, { modifiedTime: '2024-03-02T10:00:00.000Z' }),
      file(2, { modifiedTime: '2024-03-01T10:00:00.000Z' }),
      file(3, { modifiedTime: '2024-03-02T11:00:00.000Z', pieceId: 'piece-1' }),
      // Dateless: kept in `files`, in no day.
      file(4, { modifiedTime: null, createdTime: null }),
      file(5, { size: null, parents: undefined as unknown as string[] }),
    ];
    const cache = { files, activeDates: groupFilesByDate(files) };
    const decoded = decodeBootstrapFilesCache(throughJson(encodeBootstrapFilesCache(cache)))!;
    // JSON drops `undefined`, so compare with the same treatment on the input.
    expect(decoded).toEqual(throughJson(cache));
    expect(decoded.activeDates.map((day) => day.files.map((f) => f.id))).toEqual([
      ['file-2', 'file-5'],
      ['file-1', 'file-3'],
    ]);
    expect(decoded.activeDates[0]!.files[1]).toBe(decoded.files[4]);
  });
});

describe('decodeBootstrapFilesCache — legacy format (no `version`)', () => {
  it('reads what the previous writer stored, as it is', () => {
    const files = [file(1), file(2)];
    const legacy = throughJson({
      files,
      activeDates: [
        { date: '2024-03-01', files: [files[1], files[0]] },
        { date: '2024-03-02', files: [files[0]] },
      ],
    });
    const decoded = decodeBootstrapFilesCache(legacy)!;
    expect(decoded.files).toEqual(files);
    expect(decoded.activeDates.map((day) => day.date)).toEqual(['2024-03-01', '2024-03-02']);
    expect(decoded.activeDates[0]!.files.map((f) => f.id)).toEqual(['file-2', 'file-1']);
    expect(decoded.activeDates[1]!.files).toEqual([files[0]]);
    expect(logMock).not.toHaveBeenCalled();
  });

  it('reads what groupFilesByDate + the previous writer produced', () => {
    const files = [
      file(1, { modifiedTime: '2024-03-01T10:00:00.000Z' }),
      file(2, { modifiedTime: '2024-03-02T10:00:00.000Z' }),
    ];
    const legacy = throughJson({ files, activeDates: groupFilesByDate(files) });
    const decoded = decodeBootstrapFilesCache(legacy)!;
    expect(decoded).toEqual(legacy);
  });
});

describe('decodeBootstrapFilesCache — nothing usable', () => {
  it('NULL / absent is the normal no-cache state: a silent miss', () => {
    expect(decodeBootstrapFilesCache(null)).toBeNull();
    expect(decodeBootstrapFilesCache(undefined)).toBeNull();
    expect(logMock).not.toHaveBeenCalled();
  });

  const day = { date: '2024-03-01', fileIds: ['file-1'] };
  it.each([
    ['a string', 'cache'],
    ['a number', 7],
    ['an array', [file(1)]],
    ['an empty object', {}],
    ['files that is not an array', { files: {}, activeDates: [day] }],
    ['activeDates that is not an array', { version: 2, files: [file(1)], activeDates: {} }],
    ['no active days', { version: 2, files: [file(1)], activeDates: [] }],
    ['a version this code does not know', { version: 3, files: [file(1)], activeDates: [day] }],
    ['a non-numeric version', { version: '2', files: [file(1)], activeDates: [day] }],
    ['a file entry without an id', { version: 2, files: [{ name: 'x' }], activeDates: [day] }],
    ['a null file entry', { version: 2, files: [null], activeDates: [day] }],
    ['a day without fileIds', { version: 2, files: [file(1)], activeDates: [{ date: 'd' }] }],
    ['a day without a date', { version: 2, files: [file(1)], activeDates: [{ fileIds: [] }] }],
    [
      'an id that is not in files (corrupt)',
      { version: 2, files: [file(1)], activeDates: [{ date: '2024-03-01', fileIds: ['file-9'] }] },
    ],
    [
      'a non-string id in a day',
      { version: 2, files: [file(1)], activeDates: [{ date: '2024-03-01', fileIds: [1] }] },
    ],
    ['a legacy day without files', { files: [file(1)], activeDates: [{ date: '2024-03-01' }] }],
  ])('treats %s as a miss and logs why', (_what, raw) => {
    expect(decodeBootstrapFilesCache(raw)).toBeNull();
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(String(logMock.mock.calls[0]![0])).toContain('Files cache unusable');
  });

  it('names the problem, and never echoes values from the row', () => {
    const secretish = 'someone@example.com';
    decodeBootstrapFilesCache({
      version: 2,
      files: [file(1, { modifiedByEmail: secretish })],
      activeDates: [{ date: '2024-03-01', fileIds: ['file-1', 'file-9', 'file-8'] }],
    });
    const line = String(logMock.mock.calls[0]![0]);
    expect(line).toContain('active day #0 lists 2 id(s) missing from files');
    expect(line).not.toContain(secretish);
    expect(line).not.toContain('file-9');
  });
});

describe('persistBootstrapFilesCache', () => {
  it('writes the version-2 shape for the in-memory cache it is given', async () => {
    const files = [
      file(1, { modifiedTime: '2024-03-01T10:00:00.000Z' }),
      file(2, { modifiedTime: '2024-03-02T10:00:00.000Z' }),
    ];
    await persistBootstrapFilesCache('acc-1', { files, activeDates: groupFilesByDate(files) });

    expect(prismaMock.account.update).toHaveBeenCalledTimes(1);
    const arg = prismaMock.account.update.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: 'acc-1' });
    const stored = arg.data.driveBootstrapFiles;
    // Each file is in the written value once (the previous writer wrote it twice).
    const text = JSON.stringify(stored);
    for (const f of files) expect(occurrences(text, JSON.stringify(f.modifiedByEmail))).toBe(1);
    expect(stored.version).toBe(2);
    expect(stored.files).toEqual(files);
    expect(stored.activeDates).toEqual([
      { date: '2024-03-01', fileIds: ['file-1'] },
      { date: '2024-03-02', fileIds: ['file-2'] },
    ]);
    // Only the cache column is written, and only the id is read back.
    expect(Object.keys(arg.data)).toEqual(['driveBootstrapFiles']);
    expect(arg.select).toEqual({ id: true });
  });
});

// Without a `select`, Prisma's update returns every column of the row, the
// cache included: each cursor step of a bootstrap chain would read the whole
// cache back into memory.
describe('the other account writes read back only the id', () => {
  it('persistCursor, mid-chain and on completion', async () => {
    await persistCursor('acc-1', '2024-03-02');
    await persistCursor('acc-1', '2024-03-03', true);

    expect(prismaMock.account.update).toHaveBeenCalledTimes(2);
    for (const [arg] of prismaMock.account.update.mock.calls) {
      expect(arg.where).toEqual({ id: 'acc-1' });
      expect(arg.select).toEqual({ id: true });
    }
  });

  it('persistStructureCache', async () => {
    await persistStructureCache('acc-1', {} as StructureCache);

    expect(prismaMock.account.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.account.update.mock.calls[0]![0].select).toEqual({ id: true });
  });
});

describe('loadBootstrapFilesCache', () => {
  it('selects ONLY the cache column and returns the decoded cache', async () => {
    const files = [file(1), file(2)];
    const stored = throughJson(
      encodeBootstrapFilesCache({
        files,
        activeDates: [{ date: '2024-03-01', files: [files[1]!, files[0]!] }],
      }),
    );
    prismaMock.account.findUnique.mockResolvedValue({ driveBootstrapFiles: stored });

    const cache = await loadBootstrapFilesCache('acc-1');

    expect(prismaMock.account.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.account.findUnique).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      select: { driveBootstrapFiles: true },
    });
    expect(cache!.activeDates[0]!.files.map((f) => f.id)).toEqual(['file-2', 'file-1']);
    expect(cache!.activeDates[0]!.files[0]).toBe(cache!.files[1]);
  });

  it('reads a legacy-format column too', async () => {
    const files = [file(1)];
    prismaMock.account.findUnique.mockResolvedValue({
      driveBootstrapFiles: throughJson({ files, activeDates: [{ date: '2024-03-01', files }] }),
    });
    const cache = await loadBootstrapFilesCache('acc-1');
    expect(cache!.activeDates[0]!.files.map((f) => f.id)).toEqual(['file-1']);
  });

  it('is a miss for a NULL column and for a missing row', async () => {
    prismaMock.account.findUnique.mockResolvedValueOnce({ driveBootstrapFiles: null });
    expect(await loadBootstrapFilesCache('acc-1')).toBeNull();
    prismaMock.account.findUnique.mockResolvedValueOnce(null);
    expect(await loadBootstrapFilesCache('acc-2')).toBeNull();
    expect(logMock).not.toHaveBeenCalled();
  });
});
