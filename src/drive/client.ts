/**
 * drive.client.ts — Google Drive API client.
 *
 * Auth: bot-user OAuth via the 'drive' row in `bot_credentials`. The
 * Drive bot is authorized once via gub-admin Settings → Sync Credentials;
 * its refresh token persists in the DB and `buildBotOAuthClient` mints
 * short-lived access tokens at sync time. No SA, no Domain-Wide
 * Delegation, no impersonation chain.
 *
 * The earlier Path A (legacy key-file SA) and Path B (STS impersonation
 * chain) were rejected as part of the auth-no-DWD migration — see
 * docs/proposals/auth-no-dwd.md for the parent decision and
 * docs/proposals/bot-oauth-design.md for how the bot is provisioned.
 *
 * Bot user setup:
 *   1. Provision the Drive bot OAuth client + bot user out-of-band
 *      (per docs/proposals/bot-oauth-design.md setup runbook).
 *   2. Share each Drive folder the sync needs to read with
 *      bot.clientdrives@<domain> (or whatever the bot user is named).
 *   3. Authorize via gub-admin Settings → Sync Credentials → click
 *      Authorize on the 'drive' row.
 *
 * Until the bot is authorized, every public function in this module
 * throws `BotCredentialsMissingError` from `buildBotOAuthClient` with a
 * pointer to the Settings page.
 */

import { google, type drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { logger } from '../logger';
import { buildBotOAuthClient } from '../workspace';

const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

// ── Drive API client (lazy singleton, OAuth-backed) ──────────────────────────

let cachedClient: drive_v3.Drive | null = null;

/**
 * Returns a googleapis Drive client wired to the 'drive' bot's OAuth
 * credentials. Cached after first successful build. The first call does
 * a DB lookup via `buildBotOAuthClient`; subsequent calls reuse the same
 * `OAuth2Client`, which in turn handles access-token refresh internally.
 *
 * Async because the credential lookup hits the DB.
 */
export async function driveClient(): Promise<drive_v3.Drive> {
  if (cachedClient) return cachedClient;

  const auth = await buildBotOAuthClient('drive', [DRIVE_READONLY_SCOPE]);
  logger.info('[drive.client] initialized Drive client (bot-user OAuth)');

  cachedClient = google.drive({ version: 'v3', auth });
  return cachedClient;
}

// ── Low-level helpers ────────────────────────────────────────────────────────

/** Fields we always request on a file. */
export const FILE_FIELDS =
  'id,name,mimeType,parents,modifiedTime,createdTime,size,lastModifyingUser(emailAddress,displayName),shortcutDetails(targetId,targetMimeType)';

/**
 * List immediate children of a folder, following pagination.
 * Includes both files and subfolders. Trashed items excluded.
 */
export async function listFolderChildren(folderId: string): Promise<drive_v3.Schema$File[]> {
  const client = await driveClient();
  const out: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * List the immediate SUBFOLDERS of a folder (folders only, no files),
 * following pagination. Cheaper than listFolderChildren when you only
 * need the folder skeleton — the structure-resolution walk uses this to
 * map an account's campaign topology without pulling file metadata.
 */
export interface SubfolderNode {
  id: string;
  name: string;
}

export async function listSubfolders(folderId: string): Promise<SubfolderNode[]> {
  const client = await driveClient();
  const out: SubfolderNode[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id,name)',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Flat-list EVERY folder in a shared drive in one paginated sweep
 * (`corpora=drive`, mimeType=folder). ONLY valid for shared-drive ids.
 *
 * The recursive folders-only walk (listSubfolders per folder) is O(folders)
 * sequential round-trips — minutes on a big drive. This is O(folders/200)
 * paginated calls. The caller reconstructs the tree in memory from the
 * `parentId` pointers. Mirrors listSharedDriveFiles for the folder skeleton.
 */
export interface DriveFolderRec {
  id: string;
  name: string;
  /** Immediate parent id (shared-drive folders have at most one parent). */
  parentId: string | null;
}

export async function listAllFoldersInDrive(
  driveId: string,
  opts: { onPage?: (totalSoFar: number) => void } = {},
): Promise<DriveFolderRec[]> {
  const client = await driveClient();
  const out: DriveFolderRec[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.files.list({
      corpora: 'drive',
      driveId,
      q: 'trashed = false and mimeType = "application/vnd.google-apps.folder"',
      fields: 'nextPageToken, files(id,name,parents)',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name) continue;
      out.push({ id: f.id, name: f.name, parentId: f.parents?.[0] ?? null });
    }
    if (opts.onPage) opts.onPage(out.length);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Detect whether a folderId refers to a SHARED DRIVE ROOT vs a folder
 * inside one (or a folder in personal My Drive).
 *
 * Drive's data model: a shared drive has the same id as its root folder.
 * For `files.get(folderId, fields='id,driveId')`:
 *   - shared-drive root  → driveId === id
 *   - folder in shared drive → driveId !== id (and is present)
 *   - folder in My Drive → driveId is absent
 *
 * Knowing this matters for performance: a shared-drive root supports
 * `files.list(corpora='drive', driveId=X, orderBy=...)` returning the
 * entire drive's contents in one paginated query. Folders (in either
 * kind of drive) only support `'X' in parents` — direct children only —
 * forcing recursive traversal.
 */
export interface SharedDriveProbe {
  isSharedDriveRoot: boolean;
  /** When the folder lives inside a shared drive: the shared drive's id. */
  driveId: string | null;
  /** The mimeType reported by Drive. Should be folder; surfaced for sanity. */
  mimeType: string | null;
}

export async function probeFolder(folderId: string): Promise<SharedDriveProbe> {
  const client = await driveClient();
  const res = await client.files.get({
    fileId: folderId,
    fields: 'id,driveId,mimeType',
    supportsAllDrives: true,
  });
  const id = res.data.id ?? null;
  const driveId = res.data.driveId ?? null;
  const mimeType = res.data.mimeType ?? null;
  return {
    isSharedDriveRoot: !!id && !!driveId && id === driveId,
    driveId,
    mimeType,
  };
}

/**
 * Flat-list every non-folder file in a shared drive, paginated and
 * (optionally) ordered. ONLY valid for shared-drive-root ids — for
 * folders inside drives, you must walk recursively (`traverseFolder`).
 *
 * Used by backfill to skip the recursive walk for shared-drive entities.
 * Returns TraversedFile shape with `path = name` (no breadcrumb; the flat
 * query gives parent ids, not paths, and reconstructing paths costs
 * more API calls than it's usually worth at this layer).
 */
export interface FlatListOptions {
  /** Stop after this many files. Use for capped iteration. */
  maxFiles?: number;
  /** `orderBy` value. Default 'createdTime asc' for "oldest first." */
  orderBy?: string;
}

export async function listSharedDriveFiles(
  driveId: string,
  options: FlatListOptions = {},
): Promise<import('./types').TraversedFile[]> {
  const client = await driveClient();
  const out: import('./types').TraversedFile[] = [];
  const maxFiles = options.maxFiles ?? null;
  const orderBy = options.orderBy ?? 'createdTime asc';
  let pageToken: string | undefined;
  do {
    const res = await client.files.list({
      corpora: 'drive',
      driveId,
      q: 'trashed = false and mimeType != "application/vnd.google-apps.folder"',
      orderBy,
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name || !f.mimeType) continue;
      out.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        ...(f.parents ? { parents: f.parents } : {}),
        path: f.name, // flat list has no breadcrumb; degraded vs traversal
        modifiedTime: f.modifiedTime ?? null,
        modifiedByEmail: f.lastModifyingUser?.emailAddress ?? null,
        createdTime: f.createdTime ?? null,
        size: f.size ? Number(f.size) : null,
        isFolder: false,
        ...(f.shortcutDetails?.targetId && f.shortcutDetails?.targetMimeType
          ? {
              shortcutTarget: {
                id: f.shortcutDetails.targetId,
                mimeType: f.shortcutDetails.targetMimeType,
              },
            }
          : {}),
      });
      if (maxFiles !== null && out.length >= maxFiles) return out;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * List the revision metadata for a file.
 *
 * Returns one entry per revision: id, modifiedTime, lastModifyingUser
 * (email + displayName), and size. NO content fetching — purely
 * attribution-and-timestamps for the editor-telemetry use case.
 *
 * Notes:
 * - For Google-native files (Docs/Sheets/Slides), full revision history
 *   is preserved by Drive — every saved edit shows up.
 * - For binary files (PDF/DOCX/text), Drive prunes revisions after ~30
 *   days unless `keepForever=true` was explicitly set per-revision
 *   (almost never in practice). So binary files only show recent
 *   revisions; older history is gone from Drive's side.
 * - Paginates internally; revisions.list returns up to pageSize per call.
 */
export interface DriveRevisionMeta {
  revisionId: string;
  modifiedTime: string;
  editorEmail: string | null;
  editorName: string | null;
  sizeBytes: number | null;
}

export async function listRevisions(fileId: string): Promise<DriveRevisionMeta[]> {
  const client = await driveClient();
  const out: DriveRevisionMeta[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.revisions.list({
      fileId,
      fields:
        'nextPageToken, revisions(id, modifiedTime, lastModifyingUser(emailAddress,displayName), size)',
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const r of res.data.revisions ?? []) {
      if (!r.id || !r.modifiedTime) continue;
      out.push({
        revisionId: r.id,
        modifiedTime: r.modifiedTime,
        editorEmail: r.lastModifyingUser?.emailAddress ?? null,
        editorName: r.lastModifyingUser?.displayName ?? null,
        sizeBytes: r.size ? Number(r.size) : null,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Download file bytes via `files.get(alt=media)`.
 * Use `exportMedia` instead for Google-native docs (Docs/Sheets/Slides).
 */
export async function downloadFileBuffer(fileId: string): Promise<Buffer> {
  const client = await driveClient();
  const res = await client.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  return streamToBuffer(res.data as Readable);
}

/**
 * Export a Google-native doc to a specific mime type (e.g. text/plain for Docs).
 */
export async function exportFileBuffer(fileId: string, mimeType: string): Promise<Buffer> {
  const client = await driveClient();
  const res = await client.files.export(
    { fileId, mimeType },
    { responseType: 'stream' },
  );
  return streamToBuffer(res.data as Readable);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

// ── Changes API (incremental polling) ─────────────────────────────────────────

/**
 * Ask Drive for a fresh start page token. The token represents "right now —
 * any subsequent change is captured." Persist it; pass to `listChanges` later.
 *
 * Used at the end of /run-full-sync (so the very first /poll has a token to
 * call from) and as the recovery path when a previously-saved token has
 * expired (~7 days idle).
 */
export async function getStartPageToken(): Promise<string> {
  const client = await driveClient();
  const res = await client.changes.getStartPageToken({
    supportsAllDrives: true,
  });
  if (!res.data.startPageToken) {
    throw new Error('Drive returned no startPageToken');
  }
  return res.data.startPageToken;
}

/**
 * The fields we care about per change. `removed` flags deletions; `file` carries
 * the post-change file metadata when available. `fileId` is always present.
 */
export const CHANGE_FIELDS =
  'fileId,removed,changeType,time,file(id,name,mimeType,parents,modifiedTime,size,trashed,lastModifyingUser(emailAddress,displayName))';

/**
 * Iterate all changes since `startToken`, paginating internally. Yields the
 * full list of changes plus the terminal `newStartPageToken` to persist for
 * the next call.
 *
 * Critical contract:
 *   - `nextPageToken` (intermediate) is followed automatically. Callers never
 *     see it. Don't persist intermediate tokens; doing so would cause the
 *     next poll to re-process the changes between intermediate and terminal.
 *   - `newStartPageToken` (terminal, returned only on the last page) is what
 *     callers persist for the next poll cycle.
 *
 * Throws `PageTokenExpiredError` when Drive returns 410 / INVALID_PAGE_TOKEN —
 * the saved token aged past Drive's ~7-day idle window. Recovery: clear
 * persisted token, run /run-full-sync to bootstrap, persist the fresh token
 * captured at end of run.
 */
export class PageTokenExpiredError extends Error {
  constructor() {
    super('Drive page token has expired (>7d idle). Re-run /run-full-sync to recover.');
    this.name = 'PageTokenExpiredError';
  }
}

export interface ListChangesResult {
  changes: drive_v3.Schema$Change[];
  newStartPageToken: string;
}

export async function listChanges(startToken: string): Promise<ListChangesResult> {
  const client = await driveClient();
  const all: drive_v3.Schema$Change[] = [];
  let pageToken: string | undefined = startToken;
  let newStartPageToken: string | undefined;

  while (pageToken) {
    let res;
    try {
      res = await client.changes.list({
        pageToken,
        fields: `nextPageToken, newStartPageToken, changes(${CHANGE_FIELDS})`,
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        // Restrict to "my drive"-ish surface: only changes for files the bot
        // can see. We additionally filter to our configured root tree at
        // the consumer (drive.poll.ts) as a defensive belt.
        spaces: 'drive',
      });
    } catch (err) {
      if (isPageTokenExpired(err)) {
        throw new PageTokenExpiredError();
      }
      throw err;
    }

    all.push(...(res.data.changes ?? []));
    newStartPageToken = res.data.newStartPageToken ?? undefined;
    pageToken = res.data.nextPageToken ?? undefined;
  }

  if (!newStartPageToken) {
    // Drive's contract: every paginated terminal response includes
    // newStartPageToken. If it's missing, something is wrong; treat as
    // expired and bootstrap rather than silently saving nothing.
    throw new PageTokenExpiredError();
  }

  return { changes: all, newStartPageToken };
}

/** Drive returns 410 with reason="invalidPageToken" when the token has aged out. */
function isPageTokenExpired(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; errors?: Array<{ reason?: string }> };
  if (e.code === 410) return true;
  if (Array.isArray(e.errors)) {
    return e.errors.some((x) => x?.reason === 'invalidPageToken');
  }
  return false;
}

/**
 * Walk parent references upward from `fileId` until we find `rootFolderId` or
 * exhaust parents. Used as a defensive belt in drive.poll.ts: even though
 * changes.list only returns files the bot can see (which should be just our
 * root tree), an inheritance-broken subfolder could theoretically widen
 * visibility. We reject anything outside the configured root.
 *
 * Returns `true` if `fileId` is inside `rootFolderId` (or is the root itself).
 *
 * Note: this runs `files.get` per ancestor lookup. Cache miss cost scales
 * with tree depth, not breadth. Acceptable for the typical client/project
 * folder shape (3–5 levels deep). If trees get truly deep, add a parent-id
 * cache.
 */
export async function isInsideFolder(
  fileId: string,
  rootFolderId: string,
): Promise<boolean> {
  if (fileId === rootFolderId) return true;
  const client = await driveClient();
  const visited = new Set<string>();
  let current = fileId;
  while (current && !visited.has(current)) {
    visited.add(current);
    let res;
    try {
      res = await client.files.get({
        fileId: current,
        fields: 'id,parents',
        supportsAllDrives: true,
      });
    } catch (err) {
      const e = err as { code?: number };
      if (e?.code === 404) return false; // file/parent gone — not inside
      throw err;
    }
    const parents = res.data.parents ?? [];
    if (parents.includes(rootFolderId)) return true;
    if (parents.length === 0) return false; // root reached
    current = parents[0]!; // walk first parent (shared-drive files have at most one)
  }
  return false;
}
