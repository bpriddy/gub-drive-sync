/**
 * prisma.ts — single Prisma client for the Job process.
 *
 * The Job is short-lived: it boots, runs ONE mode (poll | run-full-sync |
 * continue | cron | notify | sweep-expired), and exits. A module-level
 * singleton is fine; main.ts calls `prisma.$disconnect()` before process
 * exit so the pool drains cleanly.
 *
 * Pool size override: Prisma's default is `num_physical_cpus * 2 + 1`,
 * which on Cloud Run with --cpu=1 resolves to 3. That's too tight for
 * the parallel per-entity synthesis worker pool (concurrency 8 burns
 * through the default in a hurry). We append `connection_limit=10` to
 * the DATABASE_URL — generous for our workload, comfortably under any
 * Cloud SQL instance ceiling.
 */
import { PrismaClient } from '@prisma/client';

function buildDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  // Only inject the param if the caller hasn't already set one.
  if (raw.includes('connection_limit=')) return raw;
  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}connection_limit=10`;
}

const url = buildDatabaseUrl();
export const prisma = url
  ? new PrismaClient({ datasources: { db: { url } } })
  : new PrismaClient();
