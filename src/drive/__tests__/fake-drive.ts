// A Drive v3 stand-in for the listing tests: just enough of files.list and
// files.get to tell a flat corpora=drive sweep from a per-folder walk, and
// to count the calls each one costs. Fixtures are synthetic.
//
// Not a test file itself (no .test.ts), and deliberately free of vitest
// imports: tsconfig compiles it with the rest of src/.

export const FOLDER = 'application/vnd.google-apps.folder';

export interface FakeItem {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  /** As Drive reports it: true when trashed explicitly OR via a trashed parent. */
  trashed?: boolean;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  version?: string;
  md5Checksum?: string;
  shortcutDetails?: { targetId: string; targetMimeType: string };
}

export interface FakeCall {
  op: 'list' | 'get';
  params: Record<string, unknown>;
}

export interface FakeDriveState {
  /** The fixture's shared drive id, or null for a My Drive fixture. */
  driveId: string | null;
  items: FakeItem[];
  calls: FakeCall[];
  /** Thrown by every corpora=drive list call, e.g. a membership refusal. */
  refuseDriveListing?: unknown;
  /** Thrown by corpora=drive list calls for non-folders only (the file sweep). */
  refuseFileListing?: unknown;
  /** Ids a corpora=drive listing leaves out (still readable by id and by parent). */
  hiddenFromDriveListing?: string[];
}

let state: FakeDriveState = { driveId: null, items: [], calls: [] };

export function resetFakeDrive(next: Omit<FakeDriveState, 'calls'>): FakeDriveState {
  state = { ...next, calls: [] };
  return state;
}

export function listCalls(): FakeCall[] {
  return state.calls.filter((c) => c.op === 'list');
}

const pick = (item: FakeItem): Record<string, unknown> => ({ ...item });

async function get(params: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
  state.calls.push({ op: 'get', params });
  const id = params['fileId'];
  if (state.driveId && id === state.driveId) {
    return { data: { id, driveId: state.driveId, mimeType: FOLDER } };
  }
  const item = state.items.find((i) => i.id === id);
  if (!item) throw Object.assign(new Error('File not found'), { code: 404 });
  return {
    data: { ...pick(item), ...(state.driveId ? { driveId: state.driveId } : {}) },
  };
}

async function list(params: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
  state.calls.push({ op: 'list', params });
  const pageSize = Number(params['pageSize'] ?? 100);
  // Drive accepts 1..1000 and rejects anything else.
  if (!(pageSize >= 1 && pageSize <= 1000)) {
    throw Object.assign(new Error('Invalid pageSize'), { code: 400 });
  }
  const q = String(params['q'] ?? '');

  let candidates: FakeItem[];
  if (params['corpora'] === 'drive') {
    if (state.refuseDriveListing) throw state.refuseDriveListing;
    if (state.refuseFileListing && /mimeType\s*!=/.test(q)) throw state.refuseFileListing;
    if (!state.driveId || params['driveId'] !== state.driveId) {
      throw Object.assign(new Error('Shared drive not found'), { code: 404 });
    }
    const hidden = new Set(state.hiddenFromDriveListing ?? []);
    candidates = state.items.filter((i) => !hidden.has(i.id));
  } else {
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    if (!parent) throw new Error(`fake drive: unsupported q: ${q}`);
    candidates = state.items.filter((i) => i.parents?.includes(parent));
  }

  if (/trashed\s*=\s*false/.test(q)) candidates = candidates.filter((i) => !i.trashed);
  if (/mimeType\s*=\s*['"]application\/vnd\.google-apps\.folder['"]/.test(q)) {
    candidates = candidates.filter((i) => i.mimeType === FOLDER);
  }
  if (/mimeType\s*!=\s*['"]application\/vnd\.google-apps\.folder['"]/.test(q)) {
    candidates = candidates.filter((i) => i.mimeType !== FOLDER);
  }
  const orderBy = params['orderBy'];
  if (
    orderBy === 'createdTime' ||
    orderBy === 'createdTime asc' ||
    orderBy === 'createdTime desc'
  ) {
    const dir = orderBy === 'createdTime desc' ? -1 : 1;
    candidates = [...candidates].sort(
      (a, b) => dir * (a.createdTime ?? '').localeCompare(b.createdTime ?? ''),
    );
  }

  const offset = params['pageToken'] ? Number(params['pageToken']) : 0;
  const page = candidates.slice(offset, offset + pageSize);
  const next = offset + pageSize < candidates.length ? String(offset + pageSize) : undefined;
  return { data: { files: page.map(pick), ...(next ? { nextPageToken: next } : {}) } };
}

/** What `google.drive(...)` returns under the mock. */
export const fakeDriveApi = { files: { list, get } };

// ── Fixture builders ────────────────────────────────────────────────────────

export const folder = (id: string, name: string, parent: string): FakeItem => ({
  id,
  name,
  mimeType: FOLDER,
  parents: [parent],
});

let fileSeq = 0;
export const file = (
  id: string,
  name: string,
  parent: string,
  extra: Partial<FakeItem> = {},
): FakeItem => {
  fileSeq++;
  return {
    id,
    name,
    mimeType: 'application/pdf',
    parents: [parent],
    createdTime: new Date(Date.UTC(2026, 0, 1, 0, 0, fileSeq)).toISOString(),
    modifiedTime: new Date(Date.UTC(2026, 5, 1, 0, 0, fileSeq)).toISOString(),
    size: '1024',
    version: String(10 + fileSeq),
    md5Checksum: `md5-${id}`,
    ...extra,
  };
};
