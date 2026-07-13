/**
 * clear-ideas.ts — DEV utility. Delete every idea + idea_change. Ideas are the
 * decoupled memory tier (no FK from campaigns/accounts), so `clear.ts
 * --all-campaigns` does NOT remove them — this does. idea_changes cascade on
 * the idea FK, but we delete them explicitly first to be unambiguous.
 *
 *   DATABASE_URL=…proxy… npx tsx -r dotenv/config scripts/clear-ideas.ts
 */
import { prisma } from '../src/prisma';

async function main(): Promise<void> {
  const ic = await prisma.ideaChange.deleteMany({});
  const i = await prisma.idea.deleteMany({});
  console.log(`✓ deleted ${i.count} ideas + ${ic.count} idea_changes`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
