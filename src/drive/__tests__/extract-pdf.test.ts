/**
 * extractText's PDF branch hands pdf.js a Uint8Array VIEW over the download
 * instead of a copy. A real (tiny, hand-built) PDF goes through the real
 * unpdf / pdf.js; only the Drive download is faked. A thin wrapper around
 * getDocumentProxy records what pdf.js is actually given, because the no-copy
 * property is about identity (same ArrayBuffer), which the extracted text alone
 * cannot show.
 *
 * Facts pinned here are those of the pdf.js bundled in unpdf 1.6.2: it throws on
 * a Node Buffer, uses a Uint8Array as-is only when it covers its whole
 * ArrayBuffer (copying any other view), and transfers the ArrayBuffer it is
 * given to its worker side (detaching it). If an unpdf upgrade changes the
 * transfer, the "detached" assertion fails: revisit the comment in extract.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { downloadMock, proxyCalls, destroyed } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  /** Documents whose destroy() ran: pdf.js holds the bytes until then. */
  destroyed: { count: 0 },
  proxyCalls: [] as Array<{
    isBuffer: boolean;
    ctor: string;
    buffer: ArrayBufferLike;
    byteOffset: number;
    byteLength: number;
  }>,
}));

vi.mock('googleapis', () => ({
  google: { docs: vi.fn(), slides: vi.fn(), sheets: vi.fn(), drive: vi.fn(() => ({})) },
}));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn() }));
vi.mock('../../config', () => ({
  config: {
    DRIVE_MAX_FILE_SIZE_BYTES: 26214400,
    DOWNLOAD_INFLIGHT_BYTES: 1_000_000,
    DOWNLOAD_HEAVY_BYTES: 500_000,
  },
}));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../client', () => ({ downloadFileBuffer: downloadMock }));
vi.mock('unpdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('unpdf')>();
  return {
    ...actual,
    getDocumentProxy: (
      data: Uint8Array,
      options?: Parameters<typeof actual.getDocumentProxy>[1],
    ) => {
      // Record BEFORE delegating: pdf.js detaches `data` while it loads it.
      proxyCalls.push({
        isBuffer: Buffer.isBuffer(data),
        ctor: data.constructor.name,
        buffer: data.buffer,
        byteOffset: data.byteOffset,
        byteLength: data.byteLength,
      });
      return actual.getDocumentProxy(data, options).then((pdf) => {
        const destroy = pdf.destroy.bind(pdf);
        pdf.destroy = async () => {
          destroyed.count++;
          return destroy();
        };
        return pdf;
      });
    },
  };
});

import { extractText } from '../extract';
import type { TraversedFile } from '../types';

const PHRASE = 'Quarterly status for Acme';

/** A minimal, valid one-page PDF with a single line of text. */
function buildPdf(text: string): Uint8Array {
  const enc = new TextEncoder();
  const content = `BT /F1 18 Tf 20 80 Td (${text}) Tj ET`;
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}

const PDF = buildPdf(PHRASE);

const pdfFile = (): TraversedFile => ({
  id: 'file-1',
  name: 'Acme status',
  mimeType: 'application/pdf',
  path: 'Acme / Status',
  modifiedTime: null,
  modifiedByEmail: null,
  createdTime: null,
  size: PDF.length,
  isFolder: false,
});

async function extractedText(): Promise<string> {
  const outcome = await extractText(pdfFile());
  if (outcome.kind !== 'ok')
    throw new Error(`expected an extracted PDF, got skip: ${outcome.reason}`);
  expect(outcome.extractor).toBe('pdf');
  return outcome.text;
}

beforeEach(() => {
  proxyCalls.length = 0;
  destroyed.count = 0;
  downloadMock.mockReset();
});

describe('extractText PDF branch: a view over the download, not a copy', () => {
  it("uses the download's own ArrayBuffer for a large (dedicated) download, and pdf.js detaches it", async () => {
    const dedicated = Buffer.alloc(PDF.length); // alloc() never uses the shared pool
    dedicated.set(PDF);
    const ab = dedicated.buffer;
    expect(dedicated.byteOffset).toBe(0);
    expect(ab.byteLength).toBe(PDF.length); // the view will cover the whole ArrayBuffer
    downloadMock.mockResolvedValue(dedicated);

    expect(await extractedText()).toContain(PHRASE);

    expect(proxyCalls).toHaveLength(1);
    const [seen] = proxyCalls;
    expect(seen!.isBuffer).toBe(false); // pdf.js throws on a Node Buffer
    expect(seen!.ctor).toBe('Uint8Array');
    // The same ArrayBuffer, i.e. no second copy of the file. (Compared as a
    // boolean: a failing toBe() would try to print a detached ArrayBuffer.)
    const sameArrayBuffer = seen!.buffer === ab;
    expect(sameArrayBuffer, 'pdf.js was handed a copy, not a view over the download').toBe(true);
    expect(seen!.byteOffset).toBe(0);
    expect(seen!.byteLength).toBe(PDF.length);
    // pdf.js transferred the ArrayBuffer to its worker side: the download is
    // detached now, which is why nothing may read `buf` after getDocumentProxy.
    expect(ab.byteLength).toBe(0);
    expect(dedicated.byteLength).toBe(0);
    // ...and the document holding them is destroyed before the reservation ends.
    expect(destroyed.count).toBe(1);
  });

  it('leaves the shared Buffer pool alone for a small (pooled) download: pdf.js copies it itself', async () => {
    const pooled = Buffer.from(PDF); // < 4 KiB: a slice of Node's shared 8 KiB pool
    const pool = pooled.buffer;
    const poolBytes = pool.byteLength;
    expect(poolBytes).toBeGreaterThan(PDF.length); // precondition: really pooled
    downloadMock.mockResolvedValue(pooled);

    expect(await extractedText()).toContain(PHRASE);

    const [seen] = proxyCalls;
    expect(seen!.isBuffer).toBe(false);
    expect(seen!.buffer === pool).toBe(true); // a view over the slice...
    expect(seen!.byteOffset).toBe(pooled.byteOffset);
    expect(seen!.byteLength).toBe(PDF.length);
    // ...which pdf.js copied rather than transferred: the pool is not detached,
    // the download's bytes are intact, and Node can still allocate from the pool.
    expect(pool.byteLength).toBe(poolBytes);
    expect(Buffer.compare(pooled, Buffer.from(PDF))).toBe(0);
    expect(Buffer.allocUnsafe(16).byteLength).toBe(16);
  });
});
