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
import { withTransientRetry } from './retry';
import { buildBotOAuthClient } from '../workspace';

const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

// ── Proactive rate limiting ──────────────────────────────────────────────────
//
// Drive API enforces a per-user request rate (default ~1000 / 100s, i.e.
// ~10 sustained / second). The backfill engine bursts paginated
// `files.list` calls back-to-back at the start of every Job execution —
// structure scan (~32 calls for a 6320-folder shared drive) plus file
// discovery (~127 calls for 25K files). At full unconstrained burst the
// googleapis library will issue these as fast as Drive can respond
// (50-200ms per call), which can momentarily exceed the per-100s window
// and trip a 403 `userRateLimitExceeded`.
//
// Proactive throttle (this) is the right pattern, not reactive retry:
// we space calls so the limit is never approached. Every Drive API call
// site funnels through `driveLimiter.run(...)` which guarantees a
// minimum interval between consecutive calls. Sequential by design —
// concurrent callers queue up behind whoever's currently waiting.
//
// Cost: ~125ms added per call (8 calls/sec). For Chevy's ~159 startup
// calls = ~20s of upfront throttled wall-clock vs ~5-10s of unconstrained
// burst. Acceptable, and we never get a 403 in steady state.

export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: number;
    status?: number;
    errors?: Array<{ reason?: string }>;
    response?: { status?: number; data?: { error?: { errors?: Array<{ reason?: string }> } } };
  };
  const status = e.code ?? e.status ?? e.response?.status;
  if (status !== 403 && status !== 429) return false;
  const reasons: string[] = [
    ...(e.errors ?? []).map((x) => x.reason ?? ''),
    ...(e.response?.data?.error?.errors ?? []).map((x) => x.reason ?? ''),
  ];
  // Reasons that mean "rate-limited, try again." Other 403s (auth, perms)
  // are NOT retryable and should propagate immediately.
  return reasons.some(
    (r) =>
      r === 'userRateLimitExceeded' ||
      r === 'rateLimitExceeded' ||
      r === 'quotaExceeded',
  );
}

class DriveRateLimiter {
  private chainTail: Promise<void> = Promise.resolve();
  private lastCallEndAt = 0;
  private readonly minIntervalMs: number;

  constructor(callsPerSec: number) {
    this.minIntervalMs = Math.ceil(1000 / callsPerSec);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain ourselves after the previous call's completion so multiple
    // concurrent .run() invocations get serialized (no thundering herd
    // racing on lastCallEndAt).
    const myTurn = this.chainTail;
    let resolveMine!: () => void;
    this.chainTail = new Promise<void>((resolve) => {
      resolveMine = resolve;
    });

    await myTurn;

    // Sleep until enough time has elapsed since the last call's end.
    const now = Date.now();
    const earliestStart = this.lastCallEndAt + this.minIntervalMs;
    if (now < earliestStart) {
      await new Promise((resolve) => setTimeout(resolve, earliestStart - now));
    }

    // Defense in depth: even with pacing, transient quota throttles can
    // slip through (bot user has tighter-than-documented quota,
    // cumulative effects, concurrent processes sharing the bot user).
    // Retry rate-limit errors with exponential backoff: 2s → 4s → 8s →
    // 16s → 30s. Non-rate-limit errors propagate immediately.
    const MAX_ATTEMPTS = 5;
    let lastErr: unknown;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          if (!isRateLimitError(err) || attempt === MAX_ATTEMPTS) throw err;
          const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 30_000);
          logger.warn(
            { attempt, MAX_ATTEMPTS, backoffMs },
            '[drive.client] rate-limited despite pacing — backing off and retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
      throw lastErr;
    } finally {
      this.lastCallEndAt = Date.now();
      resolveMine();
    }
  }
}

/**
 * Single shared rate limiter for ALL Drive API calls in this process.
 *
 * 4 calls/sec gives 250ms spacing. Conservative vs Drive's documented
 * 10/sec per-user limit, but real-world enforcement is often tighter
 * (bot user quotas, sliding-window edges, concurrent process effects).
 * The cost is ~40s of upfront throttled wall-clock for Chevy's ~159
 * startup calls — acceptable.
 *
 * If 4/sec STILL hits the limit, the retry-with-backoff inside .run()
 * absorbs it: we wait up to 30s and try again, up to 5 attempts. The
 * chunk continues seamlessly instead of failing with HTTP 403.
 */
const driveLimiter = new DriveRateLimiter(4);

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
    const res = await driveLimiter.run(() =>
      client.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        pageSize: 200,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        ...(pageToken ? { pageToken } : {}),
      }),
    );
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
    const res = await driveLimiter.run(() =>
      client.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'nextPageToken, files(id,name)',
        pageSize: 200,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        ...(pageToken ? { pageToken } : {}),
      }),
    );
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
    const res = await driveLimiter.run(() =>
      client.files.list({
        corpora: 'drive',
        driveId,
        q: 'trashed = false and mimeType = "application/vnd.google-apps.folder"',
        fields: 'nextPageToken, files(id,name,parents)',
        pageSize: 200,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        ...(pageToken ? { pageToken } : {}),
      }),
    );
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
  const res = await driveLimiter.run(() =>
    client.files.get({
      fileId: folderId,
      fields: 'id,driveId,mimeType',
      supportsAllDrives: true,
    }),
  );
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
    const res = await driveLimiter.run(() =>
      client.files.list({
        corpora: 'drive',
        driveId,
        q: 'trashed = false and mimeType != "application/vnd.google-apps.folder"',
        orderBy,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        pageSize: 200,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        ...(pageToken ? { pageToken } : {}),
      }),
    );
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
 * Fetch one file's metadata (FILE_FIELDS) by id. Returns null on 404 /
 * gone — the forward driver treats vanished files as skips (the
 * Activity window may reference items deleted moments later).
 *
 * Retries transient transport faults (5xx, dropped sockets); rate limits
 * are already retried inside the limiter. Anything still failing after
 * that has had sufficient effort spent on it and propagates — callers
 * decide whether to lose the file or fail the run.
 */
export async function getFileMetadata(
  fileId: string,
): Promise<drive_v3.Schema$File | null> {
  const client = await driveClient();
  try {
    const res = await withTransientRetry(() =>
      driveLimiter.run(() =>
        client.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true }),
      ),
    );
    return res.data;
  } catch (err) {
    const status =
      (err as { code?: number; response?: { status?: number } }).code ??
      (err as { response?: { status?: number } }).response?.status;
    if (status === 404) return null;
    throw err;
  }
}

/**
 * Download file bytes via `files.get(alt=media)`.
 * Use `exportMedia` instead for Google-native docs (Docs/Sheets/Slides).
 */
export async function downloadFileBuffer(fileId: string): Promise<Buffer> {
  const client = await driveClient();
  const res = await driveLimiter.run(() =>
    client.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    ),
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
      res = await driveLimiter.run(() =>
        client.files.get({
          fileId: current,
          fields: 'id,parents',
          supportsAllDrives: true,
        }),
      );
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
