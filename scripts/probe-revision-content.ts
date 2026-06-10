/**
 * probe-revision-content.ts — Fetch a specific revision's content.
 *
 * After probe-permission-test confirmed that revisions.list returns
 * revision IDs when the bot has Editor/Content Manager role, this
 * probe tries to actually fetch the BYTES of a revision via:
 *
 *     drive.revisions.get({ fileId, revisionId, alt: 'media' })
 *
 * For Google-native files (Docs/Sheets/Slides), the call may also need
 * a target mimeType for export. We try the no-mime path first and fall
 * back to PDF / text exports if that fails — and show which path
 * works.
 *
 * Output per revision:
 *   - revision metadata (modifiedTime, lastModifyingUser)
 *   - HTTP success/failure for each attempted call shape
 *   - first 500 chars of decoded content (if text-decodable)
 *   - total bytes received
 *
 * Usage:
 *   # Fetch latest revision (default)
 *   npm run probe-revision-content -- --file-id <fileId>
 *
 *   # Fetch a specific revision by ID
 *   npm run probe-revision-content -- --file-id <fileId> --revision-id 1
 *
 *   # Fetch all revisions
 *   npm run probe-revision-content -- --file-id <fileId> --all
 */

import { google } from 'googleapis';
import type { Readable } from 'node:stream';
import { prisma } from '../src/prisma';
import { buildBotOAuthClient } from '../src/workspace';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

interface Args {
  fileId?: string;
  revisionId?: string;
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  const out: Args = { all: has('--all') };
  const f = get('--file-id');
  const r = get('--revision-id');
  if (f) out.fileId = f;
  if (r) out.revisionId = r;
  return out;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface FetchResult {
  shape: string;
  status: 'success' | 'error';
  contentType: string | null;
  bytes: number;
  preview: string | null;
  errorMessage: string | null;
}

/**
 * Attempt 1: vanilla revisions.get with alt='media', no mime conversion.
 * Works for binary files. For Google-native files this may return native
 * format bytes (not directly useful) or 400 — let's see.
 */
async function tryRevisionsGetMedia(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  revisionId: string,
): Promise<FetchResult> {
  const result: FetchResult = {
    shape: "revisions.get(alt='media')",
    status: 'error',
    contentType: null,
    bytes: 0,
    preview: null,
    errorMessage: null,
  };
  try {
    const res = await drive.revisions.get(
      { fileId, revisionId, alt: 'media' },
      { responseType: 'stream' },
    );
    const buf = await streamToBuffer(res.data as Readable);
    result.status = 'success';
    result.bytes = buf.length;
    result.contentType =
      (res.headers as Record<string, string | string[]>)['content-type'] as string ?? null;
    // Best-effort text preview — first 500 chars decoded as UTF-8.
    result.preview = decodePreview(buf);
  } catch (err) {
    result.errorMessage = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/**
 * Attempt 2: pass `mimeType` on revisions.get to try export-as conversion.
 * The googleapis client may accept this even if it's not in the type
 * definitions. We send it as part of the query params via raw URL.
 *
 * This isn't a documented v3 parameter on revisions.get specifically,
 * but it works on files.export (current state). Trying it on revisions
 * is a probe — fails fast if not supported.
 */
async function tryRevisionsGetMediaWithMime(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  revisionId: string,
  mime: string,
): Promise<FetchResult> {
  const result: FetchResult = {
    shape: `revisions.get(alt='media', mimeType='${mime}')`,
    status: 'error',
    contentType: null,
    bytes: 0,
    preview: null,
    errorMessage: null,
  };
  try {
    // mimeType isn't in the typed RequestOptions for revisions.get,
    // but the googleapis client passes through unknown query params.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = { fileId, revisionId, alt: 'media', mimeType: mime };
    const res = await drive.revisions.get(params, { responseType: 'stream' });
    const buf = await streamToBuffer(res.data as unknown as Readable);
    result.status = 'success';
    result.bytes = buf.length;
    result.contentType =
      (res.headers as Record<string, string | string[]>)['content-type'] as string ?? null;
    result.preview = decodePreview(buf);
  } catch (err) {
    result.errorMessage = err instanceof Error ? err.message : String(err);
  }
  return result;
}

function decodePreview(buf: Buffer): string | null {
  if (buf.length === 0) return '(empty)';
  // Heuristic: if the first 1KB has too many non-printable bytes, treat as binary.
  const head = buf.subarray(0, Math.min(buf.length, 1024));
  let nonPrintable = 0;
  for (const byte of head) {
    if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) nonPrintable += 1;
  }
  const ratio = nonPrintable / head.length;
  if (ratio > 0.3) {
    // Probably binary. Show hex prefix.
    const hex = buf.subarray(0, Math.min(buf.length, 32)).toString('hex');
    return `(binary; first 32 bytes hex: ${hex})`;
  }
  // Looks textual.
  const text = buf.subarray(0, Math.min(buf.length, 500)).toString('utf-8');
  return text;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fileId) throw new Error('Pass --file-id <fileId>');

  console.log(`Probe target fileId: ${args.fileId}`);
  console.log('');

  const auth = await buildBotOAuthClient('drive', [DRIVE_SCOPE]);
  const drive = google.drive({ version: 'v3', auth });
  console.log('  ✓ authenticated');
  console.log('');

  // File metadata
  let fileMime = '?';
  let fileName = '?';
  try {
    const meta = await drive.files.get({
      fileId: args.fileId,
      fields: 'id, name, mimeType, createdTime, modifiedTime, capabilities(canReadRevisions)',
      supportsAllDrives: true,
    });
    fileMime = meta.data.mimeType ?? '?';
    fileName = meta.data.name ?? '?';
    console.log(`File: "${fileName}"`);
    console.log(`  mime:             ${fileMime}`);
    console.log(`  createdTime:      ${meta.data.createdTime}`);
    console.log(`  modifiedTime:     ${meta.data.modifiedTime}`);
    console.log(`  canReadRevisions: ${meta.data.capabilities?.canReadRevisions ?? '(unset)'}`);
  } catch (err) {
    throw new Error(
      `files.get failed: ${err instanceof Error ? err.message : String(err)}\n` +
        '  → Bot may not have access to this file. Check the drive sharing.',
    );
  }
  console.log('');

  // Determine which revisions to fetch
  let revisionIds: string[];
  if (args.revisionId) {
    revisionIds = [args.revisionId];
    console.log(`Targeting single revision: ${args.revisionId}`);
  } else {
    console.log('Listing revisions to pick targets…');
    const listed = await drive.revisions.list({
      fileId: args.fileId,
      pageSize: 200,
      fields: 'revisions(id, modifiedTime, lastModifyingUser(displayName))',
    });
    const all = (listed.data.revisions ?? []) as Array<{
      id?: string | null;
      modifiedTime?: string | null;
      lastModifyingUser?: { displayName?: string | null } | null;
    }>;
    if (all.length === 0) {
      console.log('  ✗ revisions.list returned 0. Cannot fetch any revisions.');
      return;
    }
    console.log(`  ${all.length} revisions returned by revisions.list.`);
    for (const r of all.slice(0, 10)) {
      console.log(`    id=${r.id}  modifiedTime=${r.modifiedTime}  by=${r.lastModifyingUser?.displayName ?? '?'}`);
    }
    if (all.length > 10) console.log(`    … (${all.length - 10} more)`);
    if (args.all) {
      revisionIds = all.map((r) => r.id).filter((id): id is string => !!id);
    } else {
      // Default: use the latest revision (last in list).
      const last = all[all.length - 1];
      if (!last?.id) {
        console.log('  ✗ latest revision has no id; cannot fetch.');
        return;
      }
      revisionIds = [last.id];
      console.log(`  Targeting latest revision: ${last.id}`);
    }
  }
  console.log('');

  // Choose which mime conversions to try based on file type.
  const triedMimes: string[] = (() => {
    if (fileMime === 'application/vnd.google-apps.document') return ['text/plain', 'application/pdf'];
    if (fileMime === 'application/vnd.google-apps.presentation') return ['application/pdf'];
    if (fileMime === 'application/vnd.google-apps.spreadsheet') return ['text/csv', 'application/pdf'];
    return []; // binary files use no mime conversion
  })();

  for (const revId of revisionIds) {
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log(`▸ Revision ${revId}`);

    // 1. Vanilla alt='media' — no mime conversion
    console.log('');
    console.log('  ── Attempt 1: alt=media (no mime conversion) ──');
    const r1 = await tryRevisionsGetMedia(drive, args.fileId, revId);
    printFetchResult(r1);

    // 2. With mime conversion (Google-native files only)
    for (const mime of triedMimes) {
      console.log('');
      console.log(`  ── Attempt 2: alt=media + mimeType="${mime}" ──`);
      const r2 = await tryRevisionsGetMediaWithMime(drive, args.fileId, revId, mime);
      printFetchResult(r2);
    }
  }

  console.log('');
  console.log('═══ Take ════════════════════════════════════════════════════════════');
  console.log('  - "success" on any shape ⇒ historical content recovery works for this');
  console.log('    file type via that shape. Use it as the canonical extractor.');
  console.log('  - All "error" ⇒ revisions exist (we listed them) but content is not');
  console.log('    fetchable. Different problem from the role gate — would need');
  console.log('    investigation (possibly different scope / different API path).');
  console.log('');
}

function printFetchResult(r: FetchResult): void {
  if (r.status === 'error') {
    console.log(`    ✗ ERROR: ${r.errorMessage}`);
    return;
  }
  console.log(`    ✓ success`);
  console.log(`      content-type: ${r.contentType ?? '(none)'}`);
  console.log(`      bytes:        ${r.bytes}`);
  console.log(`      preview (first 500 chars):`);
  const lines = (r.preview ?? '').split('\n');
  for (const line of lines.slice(0, 12)) {
    console.log(`      │ ${line}`);
  }
  if (lines.length > 12) console.log(`      │ … (${lines.length - 12} more lines)`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('');
    console.error('FAILED:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
