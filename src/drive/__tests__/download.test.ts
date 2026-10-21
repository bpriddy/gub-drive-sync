/**
 * withDownloadedFile: the scoped, budgeted download the extractors use.
 *
 * What matters here is WHEN the byte reservation is taken and released:
 *   - taken from the metadata size before anything is fetched;
 *   - still held while the caller's parser runs (the parser keeps the buffer
 *     alive and builds structures next to it);
 *   - released on every exit, including a throwing parser or a failed fetch.
 * Large downloads (at or above the heavy threshold) also log one memory line.
 * Downloads are faked at the ./client boundary; budgets are injected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { downloadMock, infoLog, cfg } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  infoLog: vi.fn(),
  cfg: { DOWNLOAD_INFLIGHT_BYTES: 1000, DOWNLOAD_HEAVY_BYTES: 100 },
}));

vi.mock('../client', () => ({ downloadFileBuffer: downloadMock }));
vi.mock('../../config', () => ({ config: cfg }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: infoLog, warn: vi.fn(), error: vi.fn() },
}));

import { ByteBudget } from '../download-budget';
import { downloadBudget, withDownloadedFile } from '../download';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const newBudget = (): ByteBudget => new ByteBudget({ capacityBytes: 1000, heavyBytes: 100 });

beforeEach(() => {
  downloadMock.mockReset();
  downloadMock.mockResolvedValue(Buffer.from('bytes'));
  infoLog.mockReset();
});

describe('withDownloadedFile', () => {
  it('reserves the metadata size before the fetch and keeps it through the parse', async () => {
    const budget = newBudget();
    let atFetch = -1;
    let atParse = -1;
    downloadMock.mockImplementation(async () => {
      atFetch = budget.inFlightBytes;
      return Buffer.from('abc');
    });

    const out = await withDownloadedFile(
      { id: 'file-1', size: 60 },
      async (buf) => {
        atParse = budget.inFlightBytes;
        return buf.toString();
      },
      budget,
    );

    expect(out).toBe('abc');
    expect(downloadMock).toHaveBeenCalledWith('file-1');
    expect(atFetch).toBe(60);
    expect(atParse).toBe(60);
    expect(budget.inFlightBytes).toBe(0);
    expect(budget.active).toBe(0);
  });

  it('takes the whole budget for a file at the heavy threshold', async () => {
    const budget = newBudget();
    let atParse = -1;
    await withDownloadedFile(
      { id: 'file-1', size: 100 },
      async () => {
        atParse = budget.inFlightBytes;
      },
      budget,
    );
    expect(atParse).toBe(1000);
  });

  it('treats an unknown size as heavy', async () => {
    const budget = newBudget();
    let atParse = -1;
    await withDownloadedFile(
      { id: 'file-1', size: null },
      async () => {
        atParse = budget.inFlightBytes;
      },
      budget,
    );
    expect(atParse).toBe(1000);
  });

  it('holds the reservation until the parse finishes, not just the transfer', async () => {
    const budget = newBudget();
    const parseA = deferred();

    const a = withDownloadedFile({ id: 'a', size: 600 }, () => parseA.promise, budget);
    await tick();
    expect(downloadMock).toHaveBeenCalledTimes(1);

    // B (600) does not fit next to A (600) in the 1000-byte budget: it must not
    // start its download while A is still parsing.
    const b = withDownloadedFile({ id: 'b', size: 600 }, async () => 'b-done', budget);
    await tick();
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(budget.queued).toBe(1);

    parseA.resolve();
    await a;
    await expect(b).resolves.toBe('b-done');
    expect(downloadMock.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(budget.inFlightBytes).toBe(0);
  });

  it('releases the reservation when the parser throws', async () => {
    const budget = newBudget();
    await expect(
      withDownloadedFile(
        { id: 'file-1', size: 900 },
        async () => {
          throw new Error('corrupt document');
        },
        budget,
      ),
    ).rejects.toThrow('corrupt document');

    expect(budget.inFlightBytes).toBe(0);
    expect(budget.active).toBe(0);
    // ...and the budget is usable again straight away.
    const release = await budget.acquire(900);
    release();
  });

  it('releases the reservation when the download fails, without calling the parser', async () => {
    const budget = newBudget();
    const use = vi.fn();
    downloadMock.mockRejectedValue(new Error('403 forbidden'));

    await expect(withDownloadedFile({ id: 'file-1', size: 900 }, use, budget)).rejects.toThrow(
      '403 forbidden',
    );

    expect(use).not.toHaveBeenCalled();
    expect(budget.inFlightBytes).toBe(0);
    expect(budget.active).toBe(0);
  });
});

const LARGE_FILE_LINE = '[drive.memory] large file in memory';

describe('memory telemetry for large downloads', () => {
  it('logs one line, with process memory, for a download at the heavy threshold', async () => {
    downloadMock.mockResolvedValue(Buffer.alloc(100));

    await withDownloadedFile({ id: 'big-1', size: 100 }, async () => 'parsed', newBudget());

    expect(infoLog).toHaveBeenCalledTimes(1);
    const [fields, message] = infoLog.mock.calls[0]!;
    expect(message).toBe(LARGE_FILE_LINE);
    expect(fields).toEqual({
      fileId: 'big-1',
      bytes: 100,
      metadataBytes: 100,
      rssBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      heapTotalBytes: expect.any(Number),
      externalBytes: expect.any(Number),
      arrayBuffersBytes: expect.any(Number),
    });
    for (const key of ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes']) {
      expect(fields[key]).toBeGreaterThan(0);
    }
    // The 100-byte Buffer is not pooled, so Node counts it under arrayBuffers.
    expect(fields.arrayBuffersBytes).toBeGreaterThanOrEqual(100);
  });

  it('logs nothing for a download below the threshold', async () => {
    downloadMock.mockResolvedValue(Buffer.alloc(99));

    await withDownloadedFile({ id: 'small-1', size: 99 }, async () => 'parsed', newBudget());

    expect(infoLog).not.toHaveBeenCalled();
  });

  it('goes by the bytes actually received, not by the metadata size', async () => {
    // Stale listing: metadata says 10 bytes (reserved as a light file), 150 arrive.
    downloadMock.mockResolvedValueOnce(Buffer.alloc(150));
    await withDownloadedFile({ id: 'grew', size: 10 }, async () => 0, newBudget());
    expect(infoLog).toHaveBeenCalledTimes(1);
    expect(infoLog.mock.calls[0]![0]).toMatchObject({
      fileId: 'grew',
      bytes: 150,
      metadataBytes: 10,
    });

    // Unknown size (reserved as heavy) but a small download: no line.
    infoLog.mockReset();
    downloadMock.mockResolvedValueOnce(Buffer.alloc(20));
    await withDownloadedFile({ id: 'tiny', size: null }, async () => 0, newBudget());
    expect(infoLog).not.toHaveBeenCalled();
  });

  it('writes the line after the transfer and before the parse', async () => {
    downloadMock.mockResolvedValue(Buffer.alloc(100));
    let loggedBeforeParse = false;

    await withDownloadedFile(
      { id: 'big-1', size: 100 },
      async () => {
        loggedBeforeParse = infoLog.mock.calls.length === 1;
      },
      newBudget(),
    );

    expect(loggedBeforeParse).toBe(true);
  });

  it('never touches the buffer after the parser has detached it (as pdf.js does)', async () => {
    const buf = Buffer.alloc(100);
    downloadMock.mockResolvedValue(buf);
    const budget = newBudget();

    await expect(
      withDownloadedFile(
        { id: 'big-1', size: 100 },
        async (b) => {
          const ab = b.buffer as ArrayBuffer; // Buffer.alloc(): never a SharedArrayBuffer
          structuredClone(ab, { transfer: [ab] }); // detaches it
          return 'ok';
        },
        budget,
      ),
    ).resolves.toBe('ok');

    expect(buf.byteLength).toBe(0);
    expect(infoLog).toHaveBeenCalledTimes(1);
    expect(infoLog.mock.calls[0]![0]).toMatchObject({ bytes: 100 }); // read before the detach
    expect(budget.inFlightBytes).toBe(0);
  });
});

describe('downloadBudget (process-wide)', () => {
  it('is built from config once and shared', () => {
    const budget = downloadBudget();
    expect(budget.capacityBytes).toBe(cfg.DOWNLOAD_INFLIGHT_BYTES);
    expect(budget.heavyBytes).toBe(cfg.DOWNLOAD_HEAVY_BYTES);
    expect(downloadBudget()).toBe(budget);
  });

  it('is what withDownloadedFile uses when no budget is passed', async () => {
    let atParse = -1;
    await withDownloadedFile({ id: 'file-1', size: 70 }, async () => {
      atParse = downloadBudget().inFlightBytes;
    });
    expect(atParse).toBe(70);
    expect(downloadBudget().inFlightBytes).toBe(0);
  });
});
