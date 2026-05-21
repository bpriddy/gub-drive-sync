/**
 * sweep.ts — Flip pending Drive change proposals past `expires_at` to
 * `state='expired'`.
 *
 * Single SQL update; idempotent (a no-op if no rows match). Surfaces as
 * the `sweep-expired` mode in main.ts — formerly the
 * POST /integrations/google-drive/sweep-expired endpoint in GUB.
 *
 * Cron target. Safe to run hourly.
 */

import { prisma } from '../prisma';
import { logger } from '../logger';

export async function sweepExpiredProposals(): Promise<{ expired: number }> {
  const result = await prisma.driveChangeProposal.updateMany({
    where: { state: 'pending', expiresAt: { lt: new Date() } },
    data: { state: 'expired' },
  });
  if (result.count > 0) {
    logger.info({ expired: result.count }, '[drive.sweep] swept expired proposals');
  }
  return { expired: result.count };
}
