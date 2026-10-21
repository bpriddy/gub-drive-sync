/**
 * extractText routes its four binary branches (PDF, DOCX, PPTX, text/*) through
 * the byte-weighted download budget, and keeps the reservation for the whole
 * parse. The parsers are faked; each fake records how many bytes the process
 * budget has reserved at the moment the parser runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  downloadMock,
  mammothExtract,
  parseOffice,
  getDocumentProxy,
  pdfExtractText,
  debugLog,
  cfg,
} = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  mammothExtract: vi.fn(),
  parseOffice: vi.fn(),
  getDocumentProxy: vi.fn(),
  pdfExtractText: vi.fn(),
  debugLog: vi.fn(),
  cfg: {
    DRIVE_MAX_FILE_SIZE_BYTES: 26214400,
    DOWNLOAD_INFLIGHT_BYTES: 1000,
    DOWNLOAD_HEAVY_BYTES: 100,
  },
}));

vi.mock('googleapis', () => ({
  google: { docs: vi.fn(), slides: vi.fn(), sheets: vi.fn(), drive: vi.fn(() => ({})) },
}));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn() }));
vi.mock('../../config', () => ({ config: cfg }));
vi.mock('../../logger', () => ({
  logger: { debug: debugLog, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../client', () => ({ downloadFileBuffer: downloadMock }));
vi.mock('mammoth', () => ({ default: { extractRawText: mammothExtract } }));
vi.mock('officeparser', () => ({ parseOfficeAsync: parseOffice }));
vi.mock('unpdf', () => ({ getDocumentProxy, extractText: pdfExtractText }));

import { downloadBudget } from '../download';
import { extractText } from '../extract';
import type { TraversedFile } from '../types';

const MIME_PDF = 'application/pdf';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function file(mimeType: string, size: number | null): TraversedFile {
  return {
    id: 'file-1',
    name: 'Acme brief',
    mimeType,
    path: 'Acme / Brief',
    modifiedTime: null,
    modifiedByEmail: null,
    createdTime: null,
    size,
    isFolder: false,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Reserved bytes seen by each fake parser at the moment it runs. */
let atParse: number[];
const reservedNow = (): number => downloadBudget().inFlightBytes;

beforeEach(() => {
  atParse = [];
  downloadMock.mockReset();
  downloadMock.mockResolvedValue(Buffer.from('file bytes'));
  debugLog.mockReset();
  mammothExtract.mockReset();
  mammothExtract.mockImplementation(async () => {
    atParse.push(reservedNow());
    return { value: 'docx text' };
  });
  parseOffice.mockReset();
  parseOffice.mockImplementation(async () => {
    atParse.push(reservedNow());
    return 'pptx text';
  });
  getDocumentProxy.mockReset();
  getDocumentProxy.mockImplementation(async () => {
    atParse.push(reservedNow());
    return {};
  });
  pdfExtractText.mockReset();
  pdfExtractText.mockResolvedValue({ text: 'pdf text' });
});

describe('extractText binary branches go through the download budget', () => {
  const branches: Array<[string, string, string]> = [
    ['PDF', MIME_PDF, 'pdf text'],
    ['DOCX', MIME_DOCX, 'docx text'],
    ['PPTX', MIME_PPTX, 'pptx text'],
  ];

  it.each(branches)(
    '%s: reserves the metadata size for the whole parse',
    async (_n, mime, text) => {
      const outcome = await extractText(file(mime, 60));
      expect(outcome).toMatchObject({ kind: 'ok', text });
      expect(atParse).toEqual([60]);
      expect(reservedNow()).toBe(0);
    },
  );

  it.each(branches)(
    '%s: a file at the heavy threshold takes the whole budget',
    async (_n, mime) => {
      await extractText(file(mime, 100));
      expect(atParse).toEqual([1000]);
      expect(reservedNow()).toBe(0);
    },
  );

  it.each(branches)('%s: an unknown size counts as heavy', async (_n, mime) => {
    await extractText(file(mime, null));
    expect(atParse).toEqual([1000]);
  });

  it('text/*: reserves the size around the download', async () => {
    let atFetch = -1;
    downloadMock.mockImplementation(async () => {
      atFetch = reservedNow();
      return Buffer.from('plain words');
    });

    const outcome = await extractText(file('text/plain', 40));

    expect(outcome).toMatchObject({ kind: 'ok', text: 'plain words', extractor: 'plaintext' });
    expect(atFetch).toBe(40);
    expect(reservedNow()).toBe(0);
  });

  it('makes a second file wait while the first one is still parsing and the two do not fit', async () => {
    const gate = deferred();
    mammothExtract.mockImplementationOnce(async () => {
      await gate.promise;
      return { value: 'first' };
    });

    const a = extractText({ ...file(MIME_DOCX, 600), id: 'a' });
    const b = extractText({ ...file(MIME_DOCX, 600), id: 'b' });
    await tick();
    expect(downloadMock.mock.calls.map((c) => c[0])).toEqual(['a']);

    gate.resolve();
    await Promise.all([a, b]);
    expect(downloadMock.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(reservedNow()).toBe(0);
  });

  it('releases the reservation and still logs + rethrows when the parser throws', async () => {
    mammothExtract.mockRejectedValue(new Error('corrupt docx'));

    await expect(extractText(file(MIME_DOCX, 60))).rejects.toThrow('corrupt docx');

    expect(reservedNow()).toBe(0);
    expect(debugLog).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file-1', mimeType: MIME_DOCX }),
      '[drive] extraction failed',
    );
  });

  it('releases the reservation when the download itself fails', async () => {
    downloadMock.mockRejectedValue(new Error('403 forbidden'));

    await expect(extractText(file(MIME_PDF, 60))).rejects.toThrow('403 forbidden');

    expect(reservedNow()).toBe(0);
    expect(getDocumentProxy).not.toHaveBeenCalled();
  });
});
