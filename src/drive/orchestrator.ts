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
import {
  distillAndEmit,
  type SourcedAccountObservation,
  type SourcedCampaignObservation,
} from './distill';
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
  skippedReason?: 'no_folder_id';
}

export async function scanEntity(input: ScanEntityInput): Promise<ScanEntityResult> {
  const ctx = await loadEntityContext(input.entityType, input.entityId);
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
      skippedReason: 'no_folder_id',
    };
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
        });
        lastDriver = res.driver;
        for (const obs of res.account) {
          accountBucket.push({ observation: obs, sourceFileId: file.id });
        }
        for (const obs of res.campaign) {
          campaignBucket.push({ observation: obs, sourceFileId: file.id });
        }
      } catch (err) {
        logger.error({ err, fileId: file.id }, '[drive.orchestrator] interpretFile failed');
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

  if (accountBucket.length > 0 && ctx.accountId) {
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
  }

  if (campaignBucket.length > 0 && ctx.campaignId && ctx.campaignState) {
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
  }

  // Update entity's drive_last_scanned_at.
  if (input.entityType === 'account') {
    await prisma.account.update({
      where: { id: input.entityId },
      data: { driveLastScannedAt: new Date() },
    });
  } else {
    await prisma.campaign.update({
      where: { id: input.entityId },
      data: { driveLastScannedAt: new Date() },
    });
  }

  return {
    scan,
    accountObservations: accountBucket.length,
    campaignObservations: campaignBucket.length,
    ...totals,
    llmDriver: distillDriver !== 'none' ? distillDriver : lastDriver,
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
