/**
 * runForward over a weekly window: the cursor is 7 days old, as it is under
 * a weekly cadence. The run scans each changed file once, in one batch dated
 * by the run; writes the week's edit tallies as one set of rows dated by the
 * run; and only then advances the cursor. I/O is mocked at the module
 * boundary; the driver, the event folding and the stats writer are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent } from '../activity';

const m = vi.hoisted(() => ({
  findAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteStats: vi.fn(),
  createStats: vi.fn(),
  transaction: vi.fn(),
  getFileMetadata: vi.fn(),
  queryActivityWindow: vi.fn(),
  processBatch: vi.fn(),
  notifyReviewers: vi.fn(),
}));

vi.mock('../../config', () => ({ config: {} }));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn() }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../prisma', () => ({
  prisma: {
    account: { findUniqueOrThrow: m.findAccount, update: m.updateAccount },
    driveEditStat: { deleteMany: m.deleteStats, createMany: m.createStats },
    $transaction: m.transaction,
  },
}));
vi.mock('../../drive/client', () => ({ getFileMetadata: m.getFileMetadata }));
vi.mock('../../drive/notify', () => ({ notifyReviewers: m.notifyReviewers }));
vi.mock('../../backfill/entity', () => ({
  loadEntity: vi.fn(async () => ({ name: 'Account One', accountId: 'acc-1', folderId: 'root-1' })),
}));
vi.mock('../../backfill/structure-stage', () => ({
  resolveAccountStructure: vi.fn(async () => ({
    attributor: null,
    nameDirectory: null,
    folderPathById: new Map(),
    familyByCampaignId: null,
  })),
}));
vi.mock('../../scan/process-batch', () => ({ processBatch: m.processBatch }));
vi.mock('../../scan/output', () => ({
  log: vi.fn(),
  rule: (t: string) => t,
  fmtMs: (n: number) => `${n}ms`,
  getLogCapture: () => null,
  setLogCapture: vi.fn(),
}));
vi.mock('../../scan/timing', () => ({
  resetPhaseTimer: vi.fn(),
  printPhaseSummary: vi.fn(),
  timed: (_phase: string, fn: () => unknown) => fn(),
}));
vi.mock('../activity', async (importActual) => ({
  ...(await importActual<typeof import('../activity')>()),
  queryActivityWindow: m.queryActivityWindow,
}));
// people/1 and people/3 are two Activity resources of the same person.
vi.mock('../people', () => ({
  resolveActors: vi.fn(
    async () =>
      new Map([
        ['people/1', 'ana@example.com'],
        ['people/2', 'ben@example.com'],
        ['people/3', 'ana@example.com'],
        ['people/4', 'cy@example.com'],
      ]),
  ),
}));

import { runForward } from '../run';
import { resolveActors } from '../people';

/** Last Monday's run at 07:00 New York, and this Monday's. */
const CURSOR = new Date('2026-10-19T11:00:00Z');
const NOW = new Date('2026-10-26T11:00:00Z');

function ev(
  fileId: string,
  timestamp: string,
  action: ActivityEvent['action'],
  actorResource: string,
): ActivityEvent {
  return { fileId, fileTitle: null, timestamp, action, actorResource };
}

/** A week of changes: doc-a on four days, doc-f on both sides of the run's
 *  own date, a rename, a delete-only file, a folder move, and a file created
 *  by someone who made no other edit. */
const WEEK: ActivityEvent[] = [
  ev('doc-a', '2026-10-19T15:00:00Z', 'edit', 'people/1'),
  ev('doc-a', '2026-10-21T09:00:00Z', 'edit', 'people/1'),
  ev('doc-a', '2026-10-22T10:00:00Z', 'edit', 'people/2'),
  ev('doc-a', '2026-10-25T18:00:00Z', 'edit', 'people/1'),
  ev('doc-b', '2026-10-20T12:00:00Z', 'create', 'people/2'),
  ev('doc-b', '2026-10-24T08:00:00Z', 'edit', 'people/3'),
  ev('doc-c', '2026-10-23T16:00:00Z', 'rename', 'people/2'),
  ev('doc-d', '2026-10-21T13:00:00Z', 'delete', 'people/1'),
  ev('folder-e', '2026-10-22T11:00:00Z', 'move', 'people/2'),
  ev('doc-f', '2026-10-25T20:00:00Z', 'edit', 'people/3'),
  ev('doc-f', '2026-10-26T10:00:00Z', 'edit', 'people/1'),
  ev('doc-g', '2026-10-24T12:00:00Z', 'create', 'people/4'),
];

const run = () => runForward({ accountId: 'acc-1', syncRunId: 'run-week' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  m.findAccount.mockResolvedValue({
    name: 'Account One',
    driveFolderId: 'root-1',
    driveBootstrapCompletedAt: new Date('2026-09-01T00:00:00Z'),
    driveForwardCursorAt: CURSOR,
  });
  m.updateAccount.mockResolvedValue({});
  m.queryActivityWindow.mockResolvedValue(WEEK);
  m.getFileMetadata.mockImplementation(async (id: string) => ({
    id,
    name: `${id}.gdoc`,
    mimeType: id.startsWith('folder-')
      ? 'application/vnd.google-apps.folder'
      : 'application/vnd.google-apps.document',
    parents: ['root-1'],
  }));
  m.processBatch.mockResolvedValue({
    stage3Failures: 0,
    transientFileErrors: 0,
    snapshotWriteFailures: 0,
    filesErrored: 0,
  });
  m.deleteStats.mockReturnValue('delete-op');
  m.createStats.mockReturnValue('create-op');
  m.transaction.mockImplementation(async (ops: unknown[]) => ops);
  m.notifyReviewers.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runForward over a 7-day window', () => {
  it('queries the whole week since the cursor in one window', async () => {
    await run();

    expect(m.queryActivityWindow).toHaveBeenCalledTimes(1);
    // The cursor minus the 2-minute overlap, up to the run's own time.
    expect(m.queryActivityWindow).toHaveBeenCalledWith(
      'root-1',
      '2026-10-19T10:58:00.000Z',
      NOW.toISOString(),
    );
  });

  it('scans each changed file once, in one batch dated by the run', async () => {
    const result = await run();

    // Once per file however many days it changed on; never the delete-only file.
    expect(m.getFileMetadata.mock.calls.map(([id]) => id).sort()).toEqual([
      'doc-a',
      'doc-b',
      'doc-c',
      'doc-f',
      'doc-g',
      'folder-e',
    ]);
    expect(m.processBatch).toHaveBeenCalledTimes(1);
    const [files, opts] = m.processBatch.mock.calls[0]!;
    expect((files as { id: string }[]).map((f) => f.id).sort()).toEqual([
      'doc-a',
      'doc-b',
      'doc-c',
      'doc-f',
      'doc-g',
    ]);
    expect(opts).toMatchObject({ application: 'propose', editedAt: '2026-10-26' });
    expect(result).toMatchObject({
      scansProcessed: 1,
      filesProcessed: 5,
      finalCursorYmd: '2026-10-26',
      activeDaysFirst: '2026-10-19',
      activeDaysLast: '2026-10-26',
      activeDaysCount: 8,
    });
  });

  it("writes the week's edit tallies as one set of rows dated by the run", async () => {
    await run();

    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.transaction).toHaveBeenCalledWith(['delete-op', 'create-op']);
    expect(m.deleteStats).toHaveBeenCalledWith({ where: { syncRunId: 'run-week' } });
    expect(m.createStats).toHaveBeenCalledTimes(1);
    const { data } = m.createStats.mock.calls[0]![0] as {
      data: { fileId: string; actorEmail: string }[];
    };
    const row = (fileId: string, actorEmail: string, editCount: number) => ({
      syncRunId: 'run-week',
      accountId: 'acc-1',
      fileId,
      day: new Date('2026-10-26T00:00:00.000Z'),
      actorEmail,
      editCount,
    });
    // Every editor of the week is resolved, including one whose only event
    // is a create.
    expect(resolveActors).toHaveBeenCalledWith(
      new Set(['people/1', 'people/2', 'people/3', 'people/4']),
    );
    // Whole-week counts per (file, person): edits and creates on any day, the
    // two resources of one person merged, renames and deletes not counted.
    expect(
      [...data].sort((a, b) =>
        `${a.fileId}|${a.actorEmail}`.localeCompare(`${b.fileId}|${b.actorEmail}`),
      ),
    ).toEqual([
      row('doc-a', 'ana@example.com', 3),
      row('doc-a', 'ben@example.com', 1),
      row('doc-b', 'ana@example.com', 1),
      row('doc-b', 'ben@example.com', 1),
      row('doc-f', 'ana@example.com', 2),
      row('doc-g', 'cy@example.com', 1),
    ]);
  });

  it('keeps every file of a busy week: 150 changed files over 7 days', async () => {
    m.queryActivityWindow.mockResolvedValue(
      Array.from({ length: 150 }, (_, i) =>
        ev(
          `doc-${i}`,
          new Date(Date.parse('2026-10-19T12:00:00Z') + (i % 7) * 86_400_000).toISOString(),
          'edit',
          'people/1',
        ),
      ),
    );

    await run();

    expect(m.processBatch).toHaveBeenCalledTimes(1);
    expect(m.processBatch.mock.calls[0]![0]).toHaveLength(150);
    expect((m.createStats.mock.calls[0]![0] as { data: unknown[] }).data).toHaveLength(150);
  });

  it('advances the cursor to the run time after the stats, and notifies once', async () => {
    await run();

    expect(m.updateAccount).toHaveBeenCalledTimes(1);
    expect(m.updateAccount).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      data: expect.objectContaining({ driveForwardCursorAt: NOW }),
    });
    expect(m.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      m.updateAccount.mock.invocationCallOrder[0]!,
    );
    expect(m.notifyReviewers).toHaveBeenCalledTimes(1);
  });
});
