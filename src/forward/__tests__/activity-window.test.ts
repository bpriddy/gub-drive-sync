/**
 * queryActivityWindow over a weekly window. Seven days of activity can hold
 * more events than one 500-activity page, so a run sees every change only if
 * the query follows nextPageToken to the last page. The googleapis client is
 * stubbed with a paged response; foldEvents is the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { driveactivity_v2 } from 'googleapis';

const m = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('googleapis', () => ({
  google: { driveactivity: vi.fn(() => ({ activity: { query: m.query } })) },
}));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn(async () => ({})) }));
vi.mock('../../config', () => ({ config: { DRIVE_READ_TIMEOUT_MS: 60_000 } }));
// Where the query is paced through the Drive limiter, pass every page
// straight through: pacing is not under test here.
vi.mock('../../drive/client', () => ({
  runThroughDriveLimiter: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { foldEvents, queryActivityWindow, type ActivityEvent } from '../activity';

const FROM = '2026-10-19T11:00:00.000Z';
const TO = '2026-10-26T11:00:00.000Z';
const HOUR_MS = 3_600_000;

/** Activity n of the week: one edit, spread hourly over the 168 hours, across 40 files and 3 editors. */
function activity(n: number): driveactivity_v2.Schema$DriveActivity {
  return {
    timestamp: new Date(Date.parse(FROM) + ((n % 168) + 0.5) * HOUR_MS).toISOString(),
    actions: [{ detail: { edit: {} } }],
    targets: [{ driveItem: { name: `items/file-${n % 40}`, title: `File ${n % 40}` } }],
    actors: [{ user: { knownUser: { personName: `people/${n % 3}` } } }],
  };
}

/** One API response holding activities [first, end), with a token when more pages follow. */
function page(first: number, end: number, nextPageToken?: string) {
  const activities = Array.from({ length: end - first }, (_, i) => activity(first + i));
  return { data: { activities, ...(nextPageToken ? { nextPageToken } : {}) } };
}

/** 1037 activities: two full pages and a short last one without a token. */
function stubThreePages(): void {
  m.query
    .mockResolvedValueOnce(page(0, 500, 'page-2'))
    .mockResolvedValueOnce(page(500, 1000, 'page-3'))
    .mockResolvedValueOnce(page(1000, 1037));
}

/**
 * Serves the three pages by token, as the API serves them, so a query that
 * restarted from scratch would get page 1 again. Page 2 fails its first
 * `page2Failures` requests. More queries than any correct run makes end the
 * test with an error instead of an endless loop.
 */
function serveByToken(page2Failures: number): void {
  let calls = 0;
  m.query.mockImplementation(async (arg: { requestBody: { pageToken?: string } }) => {
    if (++calls > 10) throw new Error('more queries than pages');
    const token = arg.requestBody.pageToken;
    if (token === 'page-2' && page2Failures-- > 0) {
      throw { code: 503, message: 'backend error' };
    }
    if (token === undefined) return page(0, 500, 'page-2');
    return token === 'page-2' ? page(500, 1000, 'page-3') : page(1000, 1037);
  });
}

const query = () => queryActivityWindow('root-1', FROM, TO);

/** Runs the query while fake time passes, so any backoff between retries elapses. */
async function settle(): Promise<{ events: ActivityEvent[] } | { error: unknown }> {
  vi.useFakeTimers();
  try {
    const settled = query().then(
      (events) => ({ events }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    return await settled;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  m.query.mockReset();
});

describe('queryActivityWindow over a 7-day window', () => {
  it('returns every event of the window when it spans three pages', async () => {
    stubThreePages();

    const events = await query();

    expect(events).toHaveLength(1037);
    expect(events.map((e) => e.timestamp)).toEqual(
      Array.from({ length: 1037 }, (_, n) => activity(n).timestamp),
    );
    expect(events[1036]).toEqual({
      fileId: 'file-36',
      fileTitle: 'File 36',
      timestamp: activity(1036).timestamp,
      action: 'edit',
      actorResource: 'people/1',
    });
  });

  it('asks for the same window on every page and passes each page token on', async () => {
    stubThreePages();

    await query();

    const window = {
      ancestorName: 'items/root-1',
      filter: `time > "${FROM}" AND time <= "${TO}"`,
      pageSize: 500,
    };
    expect(
      m.query.mock.calls.map(([arg]) => (arg as { requestBody: unknown }).requestBody),
    ).toEqual([window, { ...window, pageToken: 'page-2' }, { ...window, pageToken: 'page-3' }]);
  });

  it('never returns a partial or duplicated window when a page fails once', async () => {
    serveByToken(1);

    const result = await settle();

    // Without per-page retries the query fails as a whole; with them it
    // completes. Both leave the cursor safe. A partial or duplicated window
    // would not.
    if ('events' in result) {
      expect(result.events.map((e) => e.timestamp)).toEqual(
        Array.from({ length: 1037 }, (_, n) => activity(n).timestamp),
      );
    } else {
      expect(result.error).toEqual({ code: 503, message: 'backend error' });
    }
  });

  it('fails as a whole when a page keeps failing', async () => {
    serveByToken(Infinity);

    expect(await settle()).toEqual({ error: { code: 503, message: 'backend error' } });
  });

  it('keeps paging past an empty page that still carries a token', async () => {
    m.query
      .mockResolvedValueOnce(page(0, 300, 'page-2'))
      .mockResolvedValueOnce({ data: { nextPageToken: 'page-3' } })
      .mockResolvedValueOnce(page(300, 550));

    const events = await query();

    expect(m.query).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(550);
  });

  it('folds the whole week: every day, and one tally per file and editor', async () => {
    stubThreePages();

    const folded = foldEvents(await query());

    expect(folded.totalEvents).toBe(1037);
    // 168 hours starting at 11:00 UTC touch 8 UTC dates.
    expect([...folded.filesByDay.keys()].sort()).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    // 40 files x 3 editors; the tallies cover the whole window, so they sum
    // to every edit event, and file-0 by people/0 is every n % 120 === 0.
    expect(folded.editTallies.size).toBe(120);
    expect([...folded.editTallies.values()].reduce((a, b) => a + b, 0)).toBe(1037);
    expect(folded.editTallies.get('file-0|people/0')).toBe(9);
  });
});
