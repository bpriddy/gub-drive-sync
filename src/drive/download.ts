/**
 * drive.download.ts — scoped, budgeted file downloads for the extractors.
 *
 * `withDownloadedFile` is the only way the extractors get file bytes. It takes
 * a reservation from the process-wide byte budget (download-budget.ts) sized
 * from the file's METADATA, i.e. before anything is fetched; downloads the
 * bytes; runs the caller's parser while still holding the reservation; and
 * releases it in `finally`. The reservation has to cover the parse, not just
 * the transfer: parsers keep the buffer alive and build their own structures
 * next to it, so freeing the slot at the end of the transfer would let the next
 * download start on top of a parse that is still holding the memory.
 *
 * `use` must not start another budgeted download (a heavy holder waiting on the
 * budget would deadlock itself).
 */

import { config } from '../config';
import { logger } from '../logger';
import { downloadFileBuffer } from './client';
import { ByteBudget } from './download-budget';

let processBudget: ByteBudget | undefined;

/**
 * The process-wide budget, built from config on first use. Built lazily (not at
 * import) so importing this module has no config dependence of its own.
 */
export function downloadBudget(): ByteBudget {
  processBudget ??= new ByteBudget({
    capacityBytes: config.DOWNLOAD_INFLIGHT_BYTES,
    heavyBytes: config.DOWNLOAD_HEAVY_BYTES,
  });
  return processBudget;
}

/**
 * One line per large download (at or above the heavy threshold), written right
 * after the transfer, with the process memory at that moment: an OOM can then be
 * tied to a file and to what the budget let through. `metadataBytes` is the
 * size the reservation was taken against; far below `bytes` means the listing
 * was stale and the file was reserved as a light one. Ids and sizes only.
 */
function logLargeFile(fileId: string, bytes: number, metadataBytes: number | null): void {
  const mem = process.memoryUsage();
  logger.info(
    {
      fileId,
      bytes,
      metadataBytes,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers,
    },
    '[drive.memory] large file in memory',
  );
}

/**
 * Download `file` under the byte budget and hand the bytes to `use`. `file.size`
 * is the size from listing / files.get metadata; null (unknown) is treated as
 * heavy. `budget` exists for tests; production callers use the process-wide one.
 */
export async function withDownloadedFile<T>(
  file: { id: string; size: number | null },
  use: (buf: Buffer) => Promise<T>,
  budget: ByteBudget = downloadBudget(),
): Promise<T> {
  const release = await budget.acquire(file.size);
  try {
    const buf = await downloadFileBuffer(file.id);
    // Measured on the bytes actually received, and before `use`: the PDF parser
    // detaches the buffer it is handed, so `buf` must not be read after that.
    const bytes = buf.byteLength;
    if (bytes >= budget.heavyBytes) logLargeFile(file.id, bytes, file.size);
    return await use(buf);
  } finally {
    release();
  }
}
