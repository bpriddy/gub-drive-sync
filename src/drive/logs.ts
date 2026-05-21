/**
 * drive.logs.ts — Structured scan-log helper.
 *
 * Centralizes writes to drive_scan_logs so callers don't repeat the shape.
 * Level + category are validated against the DB CHECK constraints at insert
 * time, but callers get compile-time safety here too.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export type ScanLogLevel = 'info' | 'note' | 'warn' | 'error';
export type ScanLogCategory =
  | 'uncategorized_insight'
  | 'ambiguous'
  | 'skipped_delta'
  | 'skipped_mime'
  | 'skipped_size'
  | 'parse_error'
  | 'extract_error'
  | 'llm_error'
  | 'traversal_error'
  | 'diagnostic';

export interface ScanLogInput {
  syncRunId: string | null;
  accountId?: string | null;
  campaignId?: string | null;
  fileId?: string | null;
  level: ScanLogLevel;
  category: ScanLogCategory;
  message: string;
  payload?: Record<string, unknown> | null;
}

export async function writeScanLog(entry: ScanLogInput): Promise<void> {
  await prisma.driveScanLog.create({
    data: {
      syncRunId: entry.syncRunId,
      accountId: entry.accountId ?? null,
      campaignId: entry.campaignId ?? null,
      fileId: entry.fileId ?? null,
      level: entry.level,
      category: entry.category,
      message: entry.message,
      ...(entry.payload ? { payload: entry.payload as Prisma.InputJsonValue } : {}),
    },
  });
}
