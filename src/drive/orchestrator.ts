/**
 * drive.orchestrator.ts — LLM-enabled scan wrapper.
 *
 * Wraps scanFolder with:
 *   - Per-file Gemini interpretation via drive.interpret (onExtract hook).
 *     Each file sees both account AND campaign current state; Gemini emits
 *     observations per entity, empty arrays when it sees no change.
 *   - Two in-memory observation buckets (account + campaign) for the scan.
 *   - Post-scan distillation via drive.distill, once per entity that has
 *     any observations.
 *
 * Scanning an account: only the account bucket fills (no campaign in scope).
 * Scanning a campaign: both fill — we may learn about the parent account
 * from campaign files.
 */

import { prisma } from '../prisma';
import { logger } from '../logger';
import { progress, serializeError, summarizeError } from '../progress';
import {
  distillAndEmit,
  type SourcedAccountObservation,
  type SourcedCampaignObservation,
} from './distill';
import { healFromMarkdown } from './heal';
import { interpretFile } from './interpret';
import { writeScanLog } from './logs';
import {
  buildAccountCurrentState,
  buildCampaignCurrentState,
  type AccountCurrentState,
  type CampaignCurrentState,
} from './schema';
import { scanFolder, type ScanFolderResult } from './sync';
import type { TraversalScope } from './types';

export interface ScanEntityInput {
  entityType: 'account' | 'campaign';
  entityId: string;
  /** Optional folder override — defaults to the entity's drive_folder_id. */
  folderId?: string;
  /** Optional human label override for traversal breadcrumbs. */
  folderLabel?: string;
  syncRunId: string | null;
  /** Campaign scan still needs its parent account id for scope/logging. */
  parentAccountId?: string | null;
}

export interface ScanEntityResult {
  scan: ScanFolderResult;
  accountObservations: number;
  campaignObservations: number;
  proposalsCreated: number;
  proposalsDroppedNoOp: number;
  proposalsDroppedInvalid: number;
  notesWritten: number;
  ambiguousWritten: number;
  llmDriver: string;
  /** Heal step outcome (auto-applied structured-field extractions). */
  healFieldsApplied: number;
  skippedReason?: 'no_folder_id';
}

export async function scanEntity(input: ScanEntityInput): Promise<ScanEntityResult> {
  let ctx = await loadEntityContext(input.entityType, input.entityId);
  const folderId = input.folderId ?? ctx.driveFolderId ?? null;
  const folderLabel = input.folderLabel ?? ctx.entityName;

  if (!folderId) {
    logger.warn(
      { entityType: input.entityType, entityId: input.entityId },
      '[drive.orchestrator] no folder id configured — skipping',
    );
    return {
      scan: zeroResult(),
      accountObservations: 0,
      campaignObservations: 0,
      proposalsCreated: 0,
      proposalsDroppedNoOp: 0,
      proposalsDroppedInvalid: 0,
      notesWritten: 0,
      ambiguousWritten: 0,
      llmDriver: 'n/a',
      healFieldsApplied: 0,
      skippedReason: 'no_folder_id',
    };
  }

  // ── Heal step (FIRST in scanEntity, before scanFolder) ─────────────────
  // Auto-applies high-confidence structured-field updates from the entity's
  // existing status_markdown. See src/drive/heal.ts header for the
  // why/safety/principles. NOT a proposal flow — writes directly to the
  // entity column + audits via *_changes (changed_by = system staff).
  // Idempotent: re-running with no new markdown changes is a no-op.
  let healFieldsApplied = 0;
  if (input.entityType === 'account' && ctx.statusMarkdown) {
    const healRes = await healFromMarkdown({
      entityType: 'account',
      accountId: ctx.accountId,
      campaignId: null,
      entityName: ctx.accountName,
      currentStatusMarkdown: ctx.statusMarkdown,
      currentState: ctx.accountState,
    });
    healFieldsApplied = healRes.fieldsApplied;
    if (healRes.fieldsApplied > 0) {
      logger.info(
        { accountId: ctx.accountId, fieldsApplied: healRes.fieldsApplied },
        '[drive.orchestrator] heal step auto-applied structured fields',
      );
      // Refresh ctx so downstream distillation sees the updated state.
      ctx = await loadEntityContext(input.entityType, input.entityId);
    }
  } else if (input.entityType === 'campaign' && ctx.statusMarkdown && ctx.campaignState) {
    const healRes = await healFromMarkdown({
      entityType: 'campaign',
      accountId: ctx.accountId,
      campaignId: ctx.campaignId,
      entityName: ctx.campaignName ?? ctx.entityName,
      currentStatusMarkdown: ctx.statusMarkdown,
      currentState: ctx.campaignState,
    });
    healFieldsApplied = healRes.fieldsApplied;
    if (healRes.fieldsApplied > 0) {
      logger.info(
        { campaignId: ctx.campaignId, fieldsApplied: healRes.fieldsApplied },
        '[drive.orchestrator] heal step auto-applied structured fields',
      );
      ctx = await loadEntityContext(input.entityType, input.entityId);
    }
  }

  const scope: TraversalScope = {
    accountId: ctx.accountId,
    campaignId: ctx.campaignId,
  };

  const accountBucket: SourcedAccountObservation[] = [];
  const campaignBucket: SourcedCampaignObservation[] = [];
  let lastDriver = 'unknown';

  const scan = await scanFolder({
    folderId,
    folderLabel,
    scope,
    syncRunId: input.syncRunId,
    onExtract: async (file, extraction) => {
      try {
        const res = await interpretFile({
          file,
          text: extraction.text,
          accountName: ctx.accountName,
          accountCurrentState: ctx.accountState,
          campaignName: ctx.campaignName,
          campaignCurrentState: ctx.campaignState,
          // Forward-sync orchestrator runs in single-entity scope (one
          // account or one campaign). It doesn't fan attribution across
          // sibling campaigns the way backfill does, so subject-routing
          // metadata is captured but ignored at the bucket step. Passing
          // the scoped campaign name (when present) lets the LLM tag its
          // own observations consistently.
          knownCampaigns: ctx.campaignName ? [ctx.campaignName] : [],
        });
        lastDriver = res.driver;
        for (const obs of res.account) {
          accountBucket.push({ observation: obs, sourceFileId: file.id });
        }
        for (const obs of res.campaign) {
          campaignBucket.push({ observation: obs, sourceFileId: file.id });
        }
        // Live progress: one line per file, after both extract + interpret
        // succeeded. obs count combines account + campaign observations.
        progress.file(
          file.name,
          extraction.extractor,
          file.size,
          res.account.length + res.campaign.length,
        );
      } catch (err) {
        // Demoted from logger.error: the full error context is captured
        // in drive_scan_logs below; the streaming logger doesn't need
        // the whole error object dumped to stdout.
        logger.debug({ err, fileId: file.id }, '[drive.orchestrator] interpretFile failed');
        progress.fileError(file.name, summarizeError(err));
        await writeScanLog({
          syncRunId: input.syncRunId,
          accountId: scope.accountId,
          campaignId: scope.campaignId,
          fileId: file.id,
          level: 'error',
          category: 'llm_error',
          message: err instanceof Error ? err.message : String(err),
          payload: { path: file.path },
        });
      }
    },
  });

  // Distill per entity (if either had observations).
  let distillDriver = 'none';
  const totals = {
    proposalsCreated: 0,
    proposalsDroppedNoOp: 0,
    proposalsDroppedInvalid: 0,
    notesWritten: 0,
    ambiguousWritten: 0,
  };

  // Distillation failures must NOT take down the entity scan. The hours
  // of per-file work already committed to drive_file_snapshots are
  // preserved; the next run will delta-skip them and re-attempt
  // distillation cheaply. We surface the failure via progress + scan_log
  // and return whatever totals we have.
  if (accountBucket.length > 0 && ctx.accountId) {
    try {
      const res = await distillAndEmit({
        entityType: 'account',
        accountId: ctx.accountId,
        campaignId: null,
        syncRunId: input.syncRunId,
        observations: accountBucket,
        currentState: ctx.accountState,
        reviewerEmail: ctx.reviewerEmail,
        reviewerStaffId: ctx.reviewerStaffId,
      });
      totals.proposalsCreated += res.proposalsCreated;
      totals.proposalsDroppedNoOp += res.proposalsDroppedNoOp;
      totals.proposalsDroppedInvalid += res.proposalsDroppedInvalid;
      totals.notesWritten += res.notesWritten;
      totals.ambiguousWritten += res.ambiguousWritten;
      if (res.driver !== 'none') distillDriver = res.driver;
    } catch (err) {
      logger.debug({ err, accountId: ctx.accountId }, '[drive.orchestrator] account distillation failed');
      progress.fileError(
        `distillation (account: ${ctx.accountName})`,
        summarizeError(err),
      );
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: ctx.accountId,
        level: 'error',
        category: 'llm_error',
        message: `Account distillation failed: ${summarizeError(err)}`,
        payload: { observationsBucketed: accountBucket.length, error: serializeError(err) },
      });
    }
  }

  if (campaignBucket.length > 0 && ctx.campaignId && ctx.campaignState) {
    try {
      const res = await distillAndEmit({
        entityType: 'campaign',
        accountId: ctx.accountId,
        campaignId: ctx.campaignId,
        syncRunId: input.syncRunId,
        observations: campaignBucket,
        currentState: ctx.campaignState,
        reviewerEmail: ctx.reviewerEmail,
        reviewerStaffId: ctx.reviewerStaffId,
      });
      totals.proposalsCreated += res.proposalsCreated;
      totals.proposalsDroppedNoOp += res.proposalsDroppedNoOp;
      totals.proposalsDroppedInvalid += res.proposalsDroppedInvalid;
      totals.notesWritten += res.notesWritten;
      totals.ambiguousWritten += res.ambiguousWritten;
      if (res.driver !== 'none') distillDriver = res.driver;
    } catch (err) {
      logger.debug({ err, campaignId: ctx.campaignId }, '[drive.orchestrator] campaign distillation failed');
      progress.fileError(
        `distillation (campaign: ${ctx.campaignName ?? '(unknown)'})`,
        summarizeError(err),
      );
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: ctx.accountId,
        campaignId: ctx.campaignId,
        level: 'error',
        category: 'llm_error',
        message: `Campaign distillation failed: ${summarizeError(err)}`,
        payload: { observationsBucketed: campaignBucket.length, error: serializeError(err) },
      });
    }
  }

  // Update entity's drive_last_run_at.
  if (input.entityType === 'account') {
    await prisma.account.update({
      where: { id: input.entityId },
      data: { driveLastRunAt: new Date() },
    });
  } else {
    await prisma.campaign.update({
      where: { id: input.entityId },
      data: { driveLastRunAt: new Date() },
    });
  }

  return {
    scan,
    accountObservations: accountBucket.length,
    campaignObservations: campaignBucket.length,
    ...totals,
    llmDriver: distillDriver !== 'none' ? distillDriver : lastDriver,
    healFieldsApplied,
  };
}

// ── Context loader ─────────────────────────────────────────────────────────

interface EntityContext {
  entityName: string;
  driveFolderId: string | null;
  accountId: string;
  accountName: string;
  accountState: AccountCurrentState;
  campaignId: string | null;
  campaignName: string | null;
  campaignState: CampaignCurrentState | null;
  reviewerEmail: string | null;
  reviewerStaffId: string | null;
  /**
   * The IN-SCOPE entity's current status_markdown — i.e., the account's
   * for an account scan, the campaign's for a campaign scan. Read by the
   * heal step at the top of scanEntity to extract any high-confidence
   * structured fields the markdown supports.
   */
  statusMarkdown: string | null;
}

async function loadEntityContext(
  entityType: 'account' | 'campaign',
  entityId: string,
): Promise<EntityContext> {
  if (entityType === 'account') {
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: entityId },
      include: { owner: { select: { id: true, email: true } } },
    });
    return {
      entityName: account.name,
      driveFolderId: account.driveFolderId,
      accountId: account.id,
      accountName: account.name,
      accountState: buildAccountCurrentState(account),
      campaignId: null,
      campaignName: null,
      campaignState: null,
      reviewerEmail: account.owner?.email ?? null,
      reviewerStaffId: account.owner?.id ?? null,
      statusMarkdown: account.statusMarkdown,
    };
  }

  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: entityId },
    include: {
      account: {
        include: { owner: { select: { id: true, email: true } } },
      },
    },
  });
  return {
    entityName: campaign.name,
    driveFolderId: campaign.driveFolderId,
    accountId: campaign.account.id,
    accountName: campaign.account.name,
    accountState: buildAccountCurrentState(campaign.account),
    campaignId: campaign.id,
    campaignName: campaign.name,
    campaignState: buildCampaignCurrentState(campaign),
    reviewerEmail: campaign.account.owner?.email ?? null,
    reviewerStaffId: campaign.account.owner?.id ?? null,
    statusMarkdown: campaign.statusMarkdown,
  };
}

function zeroResult(): ScanFolderResult {
  return {
    filesSeen: 0,
    filesExtracted: 0,
    filesSkippedDelta: 0,
    filesSkippedMime: 0,
    filesSkippedSize: 0,
    filesEmpty: 0,
    folders: 0,
    errors: 0,
  };
}
