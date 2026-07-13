/** set-cursor.ts — DEV: pin an account's drive_bootstrap_cursor to a date so
 *  the next backfill scan picks the first active day AFTER it.
 *    DATABASE_URL=… npx tsx -r dotenv/config scripts/set-cursor.ts <accountNameFragment> <YYYY-MM-DD>
 */
import { prisma } from '../src/prisma';

async function main(): Promise<void> {
  const [frag, ymd] = [process.argv[2], process.argv[3]];
  if (!frag || !ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error('usage: set-cursor.ts <account> <YYYY-MM-DD>');
  const account = await prisma.account.findFirst({
    where: { name: { contains: frag, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!account) throw new Error('account not found');
  await prisma.account.update({
    where: { id: account.id },
    data: { driveBootstrapCursor: new Date(`${ymd}T00:00:00Z`), driveBootstrapCompletedAt: null },
  });
  console.log(`✓ ${account.name} cursor → ${ymd}`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
