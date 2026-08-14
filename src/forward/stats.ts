/**
 * forward/stats.ts — drive_edit_stats persistence, shared by the forward
 * driver (per day-group) and the one-shot seed-edit-stats mode.
 */

import { prisma } from '../prisma';

/**
 * Upsert one day's (file × actor) edit tallies. Overlap-safe: the
 * forward window re-reads a 2-minute boundary slice, whose recomputed
 * counts cover only part of the day — so an existing count is never
 * LOWERED, only raised (a full re-run of the same window recomputes
 * identical totals; a partial overlap can only see fewer).
 */
export async function upsertEditTallies(args: {
  accountId: string;
  day: string; // YYYY-MM-DD
  /** `${fileId}|${day}|${actorResource}` → count (all days; filtered here). */
  tallies: ReadonlyMap<string, number>;
  /** actorResource → email (or raw resource when unresolved). */
  actorEmailBy: ReadonlyMap<string, string>;
}): Promise<number> {
  let rows = 0;
  for (const [key, count] of args.tallies) {
    const [fileId, day, actor] = key.split('|') as [string, string, string];
    if (day !== args.day) continue;
    const actorEmail = args.actorEmailBy.get(actor) ?? actor;
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const existing = await prisma.driveEditStat.findUnique({
      where: { fileId_day_actorEmail: { fileId, day: dayDate, actorEmail } },
      select: { editCount: true },
    });
    const editCount = Math.max(existing?.editCount ?? 0, count);
    await prisma.driveEditStat.upsert({
      where: { fileId_day_actorEmail: { fileId, day: dayDate, actorEmail } },
      create: { accountId: args.accountId, fileId, day: dayDate, actorEmail, editCount: count },
      update: { editCount, capturedAt: new Date() },
    });
    rows++;
  }
  return rows;
}
