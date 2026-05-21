/**
 * prisma.ts — single Prisma client for the Job process.
 *
 * The Job is short-lived: it boots, runs ONE mode (poll | run-full-sync |
 * continue | cron | notify | sweep-expired), and exits. A module-level
 * singleton is fine; main.ts calls `prisma.$disconnect()` before process
 * exit so the pool drains cleanly.
 */
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
