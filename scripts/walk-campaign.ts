/**
 * walk-campaign.ts — drive a campaign-scoped backfill day-walk to completion:
 * loop runBackfill (one active day per scan, cursor-advanced) until
 * bootstrapCompleted. Pure walk driver — creates nothing; the campaign (and
 * its pieces) must already exist.
 *
 *   DATABASE_URL=… npx tsx -r dotenv/config scripts/walk-campaign.ts --campaign-id <uuid> [--max-days 100]
 */
import { runBackfill } from './backfill';
import { prisma } from '../src/prisma';

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const campaignId = argVal('--campaign-id');
  const maxDays = Number(argVal('--max-days') ?? '100');
  if (!campaignId) throw new Error('--campaign-id required');

  const started = Date.now();
  for (let day = 1; day <= maxDays; day++) {
    const res = await runBackfill({
      campaignId,
      newestFirst: false,
      outputPath: null,
      structureOnly: false,
      dryrun: false,
    });
    console.log(
      `\n===== walk ${day}: cursor=${res.finalCursorYmd ?? '(unchanged)'} files=${res.filesProcessed} completed=${res.bootstrapCompleted} elapsed=${Math.round((Date.now() - started) / 60000)}m =====\n`,
    );
    if (res.bootstrapCompleted) {
      console.log(`✓ WALK COMPLETE after ${day} scan(s) in ${Math.round((Date.now() - started) / 60000)}m`);
      return;
    }
    if (res.scansProcessed === 0) {
      console.log('⚠ no scan processed — stopping to avoid a stall');
      return;
    }
  }
  console.log(`⚠ hit --max-days cap`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
