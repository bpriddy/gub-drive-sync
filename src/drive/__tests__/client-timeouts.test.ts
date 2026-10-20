/**
 * Drive client deadlines: the read timeout on the service, and the media
 * download deadline that also covers a body which stalls mid-stream.
 */
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ driveFactory: vi.fn(), filesGet: vi.fn() }));

vi.mock('googleapis', () => ({ google: { drive: m.driveFactory } }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn(async () => ({})) }));
vi.mock('../../config', () => ({
  config: { DRIVE_READ_TIMEOUT_MS: 60_000, DRIVE_MEDIA_TIMEOUT_MS: 50 },
}));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { downloadFileBuffer, getFileMetadata } from '../client';
import { isTransientTransportError, RequestTimeoutError } from '../retry';

/** A body that sends one chunk and then stalls; destroyed when the signal aborts (as node-fetch does). */
function stalledBody(signal: AbortSignal): Readable {
  const body = new Readable({ read() {} });
  body.push(Buffer.from('partial'));
  signal.addEventListener('abort', () =>
    body.destroy(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })),
  );
  return body;
}

beforeEach(() => {
  m.filesGet.mockReset();
  m.driveFactory.mockReturnValue({ files: { get: m.filesGet } });
});

describe('downloadFileBuffer deadline', () => {
  it('aborts a download whose body stalls, with a transient-class timeout error', async () => {
    m.filesGet.mockImplementation(async (_params: unknown, opts: { signal: AbortSignal }) => ({
      data: stalledBody(opts.signal),
    }));
    const err = await downloadFileBuffer('file-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as Error).message).toBe('media download timed out after 50 ms');
    expect(isTransientTransportError(err)).toBe(true);
    // The media deadline overrides the service's read timeout on this call.
    expect(m.filesGet).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file-1', alt: 'media' }),
      expect.objectContaining({ responseType: 'stream', timeout: 50 }),
    );
  });

  it('returns the bytes of a download that completes in time', async () => {
    m.filesGet.mockResolvedValue({ data: Readable.from([Buffer.from('ab'), Buffer.from('c')]) });
    await expect(downloadFileBuffer('file-2')).resolves.toEqual(Buffer.from('abc'));
  });

  it('does not count time queued behind other Drive calls against the deadline', async () => {
    // Like gaxios: a request started on an already-aborted signal fails at once.
    m.filesGet.mockImplementation(
      async (params: { alt?: string }, opts?: { signal: AbortSignal }) => {
        if (params.alt !== 'media') {
          // A metadata call that holds the serialized limiter for 200 ms.
          await new Promise((r) => setTimeout(r, 200));
          return { data: { id: 'busy' } };
        }
        if (opts!.signal.aborted) {
          throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
        }
        return { data: Readable.from([Buffer.from('ok')]) };
      },
    );
    // That call holds the limiter for 4× the 50 ms deadline.
    const busy = getFileMetadata('other-file');
    const download = downloadFileBuffer('file-3');
    await busy;
    await expect(download).resolves.toEqual(Buffer.from('ok'));
  });

  it('builds the Drive service with the read timeout', () => {
    expect(m.driveFactory).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v3', timeout: 60_000 }),
    );
  });
});
