/**
 * SLOW — 4 concurrent 290 MiB downloads against the job's 2 GiB. Skipped unless
 * H5_SLOW=1. It allocates gigabytes, so run it ALONE and one test per process
 * (each test rebuilds config and the module graph, but RSS carries over):
 *
 *   H5_SLOW=1 npx vitest run src/drive/__tests__/download-memory.slow.test.ts -t "bounded pdf"
 *   H5_SLOW=1 npx vitest run src/drive/__tests__/download-memory.slow.test.ts -t "control pdf"
 *   (and "bounded docx" / "control docx")
 *
 * Only the edges are faked: googleapis streams 290 MiB in 1 MiB chunks at a
 * network-ish pace (the real downloadFileBuffer / streamToBuffer / Buffer.concat
 * run on it, so the ~2x transient of a transfer is real) and the parser just
 * holds what it was given for a while and returns a short text. Everything
 * between — config, extractText, the download budget — is the real code with
 * its real defaults.
 *
 *   bounded: 4 workers with the default budget. The big files are heavy, so they
 *            run one at a time. Peak RSS must stay under 2 GiB and, above all,
 *            the four files must never be in memory at once.
 *   control: the same run with the budget opened up through the environment
 *            (capacity and heavy threshold huge). All four files are then alive
 *            at once, which is what proves the bounded run measures something.
 *
 * Two parsers, because they cost differently. DOCX (mammoth) just holds the
 * Buffer. PDF is where the code used to hold a second full copy
 * (`new Uint8Array(buf)`), so before the memory work PDFs alone could reach
 * 4 x 2 x 290 MiB; the PDF variant also pins the hand-over of a view instead of
 * a copy.
 */

import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const FILE_BYTES = 290 * MIB; // under the 300 MiB DRIVE_MAX_FILE_SIZE_BYTES cap
const WORKERS = 4;
const CHUNK_MS = 5; // per 1 MiB chunk: ~200 MiB/s, so a file takes ~1.5 s to arrive

const { filesGet, PARSER_HOLD_MS } = vi.hoisted(() => {
  // `config` is the real one and insists on this.
  process.env['DATABASE_URL'] ??= 'postgresql://user:pass@localhost:5432/test';
  return {
    filesGet: vi.fn(),
    // How long the fake parser holds what it was given. The Drive client spaces
    // its calls 250 ms apart, so this must outlast three of those gaps plus a
    // transfer for all four files to be alive at once when nothing bounds them.
    PARSER_HOLD_MS: 1500,
  };
});

vi.mock('googleapis', () => ({
  google: {
    docs: vi.fn(),
    slides: vi.fn(),
    sheets: vi.fn(),
    drive: vi.fn(() => ({ files: { get: filesGet } })),
  },
}));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn().mockResolvedValue({}) }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The parsers are plain functions on purpose, not vi.fn(): a mock keeps the
// arguments of every call, i.e. every 290 MiB buffer, alive until it is reset,
// which would inflate the very peak this test measures. They touch their input
// after the wait so it is certainly alive for all of it.
vi.mock('mammoth', () => ({
  default: {
    extractRawText: async ({ buffer }: { buffer: Buffer }) => {
      await new Promise((resolve) => setTimeout(resolve, PARSER_HOLD_MS));
      return { value: buffer.byteLength > 0 ? 'short text' : '' };
    },
  },
}));
vi.mock('unpdf', () => ({
  getDocumentProxy: async (data: Uint8Array) => {
    await new Promise((resolve) => setTimeout(resolve, PARSER_HOLD_MS));
    return { numPages: data.byteLength > 0 ? 1 : 0 };
  },
  extractText: async () => ({ text: 'short text' }),
}));

import type { TraversedFile } from '../types';

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;
type Kind = keyof typeof MIME;

/**
 * A Drive media download: `total` bytes in 1 MiB chunks, each one really
 * written, at a network-ish pace. Not instant on purpose: with an instant
 * stream the four transfers would finish one after another (the Drive client
 * starts them 250 ms apart) and the garbage of each would be collected before
 * the next began, which is not what a real download looks like.
 */
function driveStream(total: number): Readable {
  let sent = 0;
  let n = 0;
  return new Readable({
    read() {
      if (sent >= total) {
        this.push(null);
        return;
      }
      const size = Math.min(MIB, total - sent);
      sent += size;
      setTimeout(() => {
        // fill(): untouched pages are not resident, and RSS is what the job's
        // memory limit counts.
        this.push(Buffer.allocUnsafe(size).fill(n++ & 0xff));
      }, CHUNK_MS);
    },
  });
}

function file(kind: Kind, i: number): TraversedFile {
  return {
    id: `file-${i}`,
    name: `Acme deck ${i}`,
    mimeType: MIME[kind],
    path: `Acme / Deck ${i}`,
    modifiedTime: null,
    modifiedByEmail: null,
    createdTime: null,
    size: FILE_BYTES,
    isFolder: false,
  };
}

const mib = (n: number): number => Math.round(n / MIB);

interface Measured {
  baseline: number;
  /** Highest RSS seen, from sampling and from the kernel's own high-water mark. */
  peak: number;
}

async function run(label: string, kind: Kind, env: Record<string, string>): Promise<Measured> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    // A fresh module graph: config (and the process-wide budget) read `env`.
    vi.resetModules();
    const { extractText } = await import('../extract');

    filesGet.mockReset();
    filesGet.mockImplementation(async () => ({ data: driveStream(FILE_BYTES) }));

    const baseline = process.memoryUsage.rss();
    let sampledPeak = baseline;
    const sampler = setInterval(() => {
      sampledPeak = Math.max(sampledPeak, process.memoryUsage.rss());
    }, 10);
    let outcomes;
    try {
      outcomes = await Promise.all(
        Array.from({ length: WORKERS }, (_, i) => extractText(file(kind, i))),
      );
    } finally {
      clearInterval(sampler);
    }
    sampledPeak = Math.max(sampledPeak, process.memoryUsage.rss());
    // The kernel's own high-water mark catches spikes between samples. It spans
    // this whole process, start-up included, so `peak - baseline` is a slight
    // overestimate of what the run itself added.
    const kernelPeak = process.resourceUsage().maxRSS * 1024;
    const peak = Math.max(sampledPeak, kernelPeak);

    expect(outcomes.map((o) => o.kind)).toEqual(Array(WORKERS).fill('ok'));
    console.log(
      `[h5-slow] ${label} ${kind}: ${WORKERS} x ${mib(FILE_BYTES)} MiB | baseline ${mib(baseline)} MiB, ` +
        `sampled peak ${mib(sampledPeak)} MiB, kernel maxRSS ${mib(kernelPeak)} MiB, ` +
        `peak - baseline ${mib(peak - baseline)} MiB | limit ${mib(2 * GIB)} MiB`,
    );
    return { baseline, peak };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe.skipIf(process.env['H5_SLOW'] !== '1')('4 x 290 MiB downloads vs a 2 GiB job', () => {
  it.each(['pdf', 'docx'] as const)(
    'bounded %s: the default budget keeps peak RSS under 2 GiB, never all four files at once',
    async (kind) => {
      const { baseline, peak } = await run('bounded', kind, {});
      expect(peak).toBeLessThan(2 * GIB);
      expect(peak - baseline).toBeLessThan(WORKERS * FILE_BYTES);
    },
    180_000,
  );

  it.each(['pdf', 'docx'] as const)(
    'control %s: with the budget opened up all four files are in memory at once',
    async (kind) => {
      const huge = String(2 ** 40);
      const { baseline, peak } = await run('control', kind, {
        DOWNLOAD_INFLIGHT_BYTES: huge,
        DOWNLOAD_HEAVY_BYTES: huge,
      });
      expect(peak - baseline).toBeGreaterThanOrEqual(WORKERS * FILE_BYTES);
    },
    180_000,
  );
});
