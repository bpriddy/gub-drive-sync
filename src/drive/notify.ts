/**
 * drive.notify.ts — Fan out per-owner magic-link review emails.
 *
 * Called at the end of a successful Drive sync (and/or on demand). Groups
 * pending + not-yet-notified proposals by reviewer_staff_id, renders one
 * magic-link email per owner, and dispatches via the `mail` module.
 *
 * Token model: each proposal already has its own unique review_token. The
 * magic link carries ONE of them as the "entry" token — the review endpoint
 * resolves that token to a reviewer_staff_id and shows all pending proposals
 * for that reviewer. Using a per-proposal token as the entry is fine: the
 * whole point of the token is to authenticate the bearer as the owner, and
 * all of this owner's pending proposals live inside the blast radius we're
 * already granting. Per-proposal tokens also remain useful server-side as a
 * stable audit handle.
 *
 * Orphan proposals (reviewer_staff_id IS NULL, typical for new top-level
 * account proposals where we haven't mapped an owner yet) are logged to
 * drive_scan_logs under category 'diagnostic' and left for admin review
 * out-of-band. We never drop them silently.
 *
 * Idempotency: once an email dispatches successfully we stamp notified_at
 * on every proposal included in that email. A second call with the same
 * syncRunId is a no-op; a later run will only pick up newer proposals.
 *
 * Works in dev with MAIL_DRIVER=console — the rendered email (including the
 * magic-link URL) prints to stdout, so the review UI can be built and
 * exercised end-to-end without Mailgun credentials.
 */

import { config } from '../config';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { mail } from '../mail';
import { writeScanLog } from './logs';

export interface NotifyInput {
  /** When set, only consider proposals from this sync run. */
  syncRunId?: string | null;
}

export interface NotifyResult {
  ownersEmailed: number;
  proposalsNotified: number;
  orphansLogged: number;
  emailDriver: string;
}

interface PendingRow {
  id: string;
  kind: string;
  proposalGroupId: string | null;
  reviewToken: string;
  reviewerStaffId: string | null;
  reviewerEmail: string | null;
  property: string;
  entityType: string;
  accountId: string | null;
  campaignId: string | null;
  sourceDriveFolderId: string | null;
  syncRunId: string | null;
}

export async function notifyReviewers(input: NotifyInput = {}): Promise<NotifyResult> {
  const rows = await prisma.driveChangeProposal.findMany({
    where: {
      state: 'pending',
      notifiedAt: null,
      ...(input.syncRunId ? { syncRunId: input.syncRunId } : {}),
    },
    select: {
      id: true,
      kind: true,
      proposalGroupId: true,
      reviewToken: true,
      reviewerStaffId: true,
      reviewerEmail: true,
      property: true,
      entityType: true,
      accountId: true,
      campaignId: true,
      sourceDriveFolderId: true,
      syncRunId: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // ── Route orphans (no reviewer) to scan-logs ─────────────────────────────
  const orphans = rows.filter((r) => !r.reviewerStaffId);
  for (const orphan of orphans) {
    await writeScanLog({
      syncRunId: orphan.syncRunId,
      accountId: orphan.accountId,
      campaignId: orphan.campaignId,
      level: 'warn',
      category: 'diagnostic',
      message: `Proposal has no reviewer_staff_id — needs admin routing before it can be reviewed`,
      payload: {
        proposalId: orphan.id,
        kind: orphan.kind,
        property: orphan.property,
        folderId: orphan.sourceDriveFolderId,
      },
    });
  }

  const withReviewer: PendingRow[] = rows.filter(
    (r): r is PendingRow & { reviewerStaffId: string } => !!r.reviewerStaffId,
  );

  // ── Group by reviewer ────────────────────────────────────────────────────
  const byReviewer = new Map<string, PendingRow[]>();
  for (const row of withReviewer) {
    const bucket = byReviewer.get(row.reviewerStaffId!) ?? [];
    bucket.push(row);
    byReviewer.set(row.reviewerStaffId!, bucket);
  }

  if (byReviewer.size === 0) {
    logger.info(
      { syncRunId: input.syncRunId ?? null, orphans: orphans.length },
      '[drive.notify] no eligible proposals to notify',
    );
    return {
      ownersEmailed: 0,
      proposalsNotified: 0,
      orphansLogged: orphans.length,
      emailDriver: mail.driverName,
    };
  }

  let ownersEmailed = 0;
  let proposalsNotified = 0;

  for (const [reviewerStaffId, bucket] of byReviewer.entries()) {
    // Resolve the current email from staff (avoid stale cached reviewerEmail).
    const staff = await prisma.staff.findUnique({
      where: { id: reviewerStaffId },
      select: { id: true, email: true, fullName: true, status: true },
    });
    if (!staff || staff.status !== 'active' || !staff.email) {
      logger.warn(
        { reviewerStaffId, bucketSize: bucket.length },
        '[drive.notify] reviewer staff not active or lacks email — skipping batch',
      );
      for (const r of bucket) {
        await writeScanLog({
          syncRunId: null,
          accountId: r.accountId,
          campaignId: r.campaignId,
          level: 'warn',
          category: 'diagnostic',
          message: 'Reviewer staff missing/inactive at notify time — proposal left pending',
          payload: { proposalId: r.id, reviewerStaffId },
        });
      }
      continue;
    }

    // Pick any token as the entry — first one (arbitrary but stable).
    const entryToken = bucket[0]!.reviewToken;
    const magicLink = buildMagicLink(entryToken);

    // Summarize what's in the bundle for the email body.
    const newEntityGroups = new Set(
      bucket.filter((r) => r.kind === 'new_entity' && r.proposalGroupId).map((r) => r.proposalGroupId!),
    ).size;
    const fieldChanges = bucket.filter((r) => r.kind === 'field_change').length;

    const { subject, text, html } = renderReviewEmail({
      reviewerName: staff.fullName,
      magicLink,
      fieldChanges,
      newEntityGroups,
      ttlDays: config.DRIVE_PROPOSAL_TTL_DAYS,
    });

    try {
      await mail.send({
        to: { email: staff.email, name: staff.fullName },
        subject,
        text,
        html,
        tags: {
          'drive.review_notification': reviewerStaffId,
        },
      });
    } catch (err) {
      logger.error(
        { err, reviewerStaffId, bucketSize: bucket.length },
        '[drive.notify] mail dispatch failed — leaving proposals unnotified',
      );
      continue;
    }

    // Stamp notified_at after successful dispatch.
    const notifiedAt = new Date();
    const proposalIds = bucket.map((r) => r.id);
    await prisma.driveChangeProposal.updateMany({
      where: { id: { in: proposalIds } },
      data: { notifiedAt },
    });

    ownersEmailed++;
    proposalsNotified += bucket.length;
    logger.info(
      {
        reviewerStaffId,
        reviewerEmail: staff.email,
        proposals: bucket.length,
        fieldChanges,
        newEntityGroups,
      },
      '[drive.notify] review email dispatched',
    );
  }

  return {
    ownersEmailed,
    proposalsNotified,
    orphansLogged: orphans.length,
    emailDriver: mail.driverName,
  };
}

// ── Rendering ──────────────────────────────────────────────────────────────

function buildMagicLink(token: string): string {
  // Review links point at gub-review (public Cloud Run, no IAP), not
  // gub-admin (IAP-fronted, internal-only). Falls back to GUB_ADMIN_BASE_URL
  // so older deployments without GUB_REVIEW_BASE_URL set still function —
  // the review route was originally served from gub-admin.
  const baseUrl = config.GUB_REVIEW_BASE_URL ?? config.GUB_ADMIN_BASE_URL;
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/drive-review/${token}`;
}

interface RenderInput {
  reviewerName: string;
  magicLink: string;
  fieldChanges: number;
  newEntityGroups: number;
  ttlDays: number;
}

function renderReviewEmail(i: RenderInput): { subject: string; text: string; html: string } {
  const parts: string[] = [];
  if (i.newEntityGroups > 0) {
    parts.push(`${i.newEntityGroups} new ${i.newEntityGroups === 1 ? 'folder' : 'folders'}`);
  }
  if (i.fieldChanges > 0) {
    parts.push(`${i.fieldChanges} ${i.fieldChanges === 1 ? 'change' : 'changes'}`);
  }
  const summary = parts.length > 0 ? parts.join(' and ') : 'items';
  const subject = `Drive sync: ${summary} need your review`;

  const text = [
    `Hi ${i.reviewerName},`,
    '',
    `The latest Google Drive scan found ${summary} for accounts you own.`,
    '',
    `Review and approve here:`,
    `  ${i.magicLink}`,
    '',
    `This link expires in ${i.ttlDays} days. Unreviewed proposals roll forward to the next run.`,
    '',
    '— GUB Drive sync',
  ].join('\n');

  const html = [
    `<p>Hi ${escapeHtml(i.reviewerName)},</p>`,
    `<p>The latest Google Drive scan found <strong>${escapeHtml(summary)}</strong> for accounts you own.</p>`,
    `<p><a href="${escapeAttr(i.magicLink)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Review &amp; approve</a></p>`,
    `<p style="color:#666;font-size:12px">Or paste this URL: <br/><code>${escapeHtml(i.magicLink)}</code></p>`,
    `<p style="color:#666;font-size:12px">This link expires in ${i.ttlDays} days. Unreviewed proposals roll forward to the next run.</p>`,
    `<p style="color:#999;font-size:12px">— GUB Drive sync</p>`,
  ].join('\n');

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
