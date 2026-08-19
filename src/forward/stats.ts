/**
 * forward/stats.ts — drive_edit_stats persistence, shared by the forward
 * driver and the seed-edit-stats mode.
 *
 * Run framing (user ruling 2026-08-15, review finding #1): a stats row
 * is one RUN's count of one actor's edit events on one file, dated by
 * the run — the same day framing the drive scan uses. Same-day runs are
 * separate contributions summed at query time (the panel GROUPs by
 * actor/day anyway), and a retry REPLACES its own run's rows, so no
 * cross-window merge function exists at all. This is what makes the
 * write idempotent without pretending partial windows can reconstruct
 * "day truth" — they never could.
 */

import { prisma } from '../prisma';

export async function writeRunEditStats(args: {
  accountId: string;
  /** drive_sync_runs id, or a synthetic uuid for seed windows. */
  syncRunId: string;
  /** The run's date, YYYY-MM-DD (drive-scan day framing). */
  day: string;
  /** `${fileId}|${actorResource}` → whole-window count (from foldEvents). */
  tallies: ReadonlyMap<string, number>;
  /** actorResource → email (or raw resource when unresolved). */
  actorEmailBy: ReadonlyMap<string, string>;
}): Promise<number> {
  // Collapse to (file, email) first — two resources can resolve to the
  // same email, and the PK is (run, file, email).
  const byRow = new Map<string, number>();
  for (const [key, count] of args.tallies) {
    const [fileId, actor] = key.split('|') as [string, string];
    const email = args.actorEmailBy.get(actor) ?? actor;
    const rowKey = `${fileId}|${email}`;
    byRow.set(rowKey, (byRow.get(rowKey) ?? 0) + count);
  }
  const dayDate = new Date(`${args.day}T00:00:00.000Z`);
  const rows = Array.from(byRow, ([rowKey, editCount]) => {
    const [fileId, actorEmail] = rowKey.split('|') as [string, string];
    return {
      syncRunId: args.syncRunId,
      accountId: args.accountId,
      fileId,
      day: dayDate,
      actorEmail,
      editCount,
    };
  });

  // Replace THIS run's contribution atomically — a retry of the same
  // run (or seed window) overwrites itself and touches nobody else.
  await prisma.$transaction([
    prisma.driveEditStat.deleteMany({ where: { syncRunId: args.syncRunId } }),
    ...(rows.length > 0 ? [prisma.driveEditStat.createMany({ data: rows })] : []),
  ]);
  return rows.length;
}
