/**
 * forward/seed.ts — one-shot historical edit-stats seed (design Q3).
 *
 * Replays windowed Activity queries back ~1 year (the probe-verified
 * retention horizon on Chevy; older events don't exist server-side) and
 * upserts the same per-(file, day, actor) tallies the forward driver
 * maintains from now on. Stats only — no scanning, no proposals, no
 * cursor movement. Idempotent: re-running recomputes identical counts.
 *
 * Invoked via `main.ts seed-edit-stats [--account-id X]`, once per
 * account at validation time.
 */

import { prisma } from '../prisma';
import { log, rule } from '../scan/output';
import { queryActivityWindow, foldEvents } from './activity';
import { resolveActors } from './people';
import crypto from 'node:crypto';
import { writeRunEditStats } from './stats';

export interface SeedEditStatsResult {
  accounts: number;
  windows: number;
  events: number;
  statRows: number;
}

export async function seedEditStats(args: {
  accountId?: string;
  daysBack?: number;
  windowDays?: number;
}): Promise<SeedEditStatsResult> {
  const daysBack = args.daysBack ?? 365;
  const windowDays = args.windowDays ?? 30;

  const accounts = await prisma.account.findMany({
    where: {
      driveFolderId: { not: null },
      ...(args.accountId ? { id: args.accountId } : {}),
    },
    select: { id: true, name: true, driveFolderId: true },
  });

  const result: SeedEditStatsResult = { accounts: 0, windows: 0, events: 0, statRows: 0 };
  const now = Date.now();

  for (const account of accounts) {
    result.accounts++;
    log('');
    log(rule(`Seed edit stats: ${account.name}  (~${daysBack}d back, ${windowDays}d windows)`));

    for (let offset = daysBack; offset > 0; offset -= windowDays) {
      const fromIso = new Date(now - offset * 86_400_000).toISOString();
      const toIso = new Date(now - Math.max(0, offset - windowDays) * 86_400_000).toISOString();
      const events = await queryActivityWindow(account.driveFolderId!, fromIso, toIso);
      result.windows++;
      result.events += events.length;
      if (events.length === 0) continue;

      const folded = foldEvents(events);
      const actorEmailBy = await resolveActors(folded.actorResources);
      // Run framing: each seed window is a synthetic "run" dated by its
      // window end. Re-seeding with the same windows produces new run
      // ids — TRUNCATE first (the migration does) or accept additive
      // re-seeds only after a wipe; forward runs are unaffected either
      // way (they own their queue-row ids).
      const windowRows = await writeRunEditStats({
        accountId: account.id,
        syncRunId: crypto.randomUUID(),
        day: toIso.slice(0, 10),
        tallies: folded.editTallies,
        actorEmailBy,
      });
      result.statRows += windowRows;
      log(
        `  ${fromIso.slice(0, 10)} → ${toIso.slice(0, 10)}: ${events.length} event(s) → ${windowRows} stat row(s)`,
      );
    }
  }

  log('');
  log(
    rule(
      `Seed done — ${result.accounts} account(s), ${result.windows} window(s), ${result.events} event(s), ${result.statRows} stat row(s)`,
    ),
  );
  return result;
}
