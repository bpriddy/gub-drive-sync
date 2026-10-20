/**
 * Contract with googleapis 144 / gaxios 6, against a local server that never
 * answers: a service-level `timeout` really aborts the request, and the
 * error it produces is one isTransientTransportError recognises. Hermetic —
 * every request goes to 127.0.0.1 (asserted).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { google } from 'googleapis';
import { isTransientTransportError } from '../retry';

let server: Server;
let rootUrl: string;
let hits: string[] = [];

beforeAll(async () => {
  server = createServer((req) => {
    hits.push(`${req.method} ${req.url}`); // never respond
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = [];
});

describe('googleapis service-level timeout', () => {
  it('aborts a stalled GET; gaxios retries it twice before giving up', async () => {
    const drive = google.drive({ version: 'v3', timeout: 150 });
    const err = await drive.files.get({ fileId: 'f1' }, { rootUrl }).catch((e: unknown) => e);
    expect(isTransientTransportError(err)).toBe(true);
    expect((err as { error?: { type?: string } }).error?.type).toBe('request-timeout');
    expect(hits).toEqual(Array(3).fill('GET /drive/v3/files/f1'));
  });

  it('aborts a stalled POST once — gaxios never retries POST, our wrapper must', async () => {
    const activity = google.driveactivity({ version: 'v2', timeout: 150 });
    const err = await activity.activity
      .query({ requestBody: { pageSize: 1 } }, { rootUrl })
      .catch((e: unknown) => e);
    expect(isTransientTransportError(err)).toBe(true);
    expect(hits).toEqual(['POST /v2/activity:query']);
  });
});
