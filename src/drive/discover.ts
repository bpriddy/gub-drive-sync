/**
 * drive.discover.ts — New-entity discovery.
 *
 * Two passes, one weekly run:
 *
 *   1. Top-level pass: enumerate children of DRIVE_ROOT_FOLDER_ID. Any folder
 *      whose id isn't present as an `accounts.drive_folder_id` becomes a
 *      "new account" proposal group.
 *
 *   2. Per-account pass: for every *already linked* account (drive_folder_id
 *      set), enumerate its children. Any folder whose id isn't present as a
 *      `campaigns.drive_folder_id` under that account becomes a "new campaign"
 *      proposal group under that account.
 *
 * New-campaign proposals ride the same weekly cadence: week 1 creates new
 * accounts, owners approve, week 2's pass finds those accounts and proposes
 * campaigns inside them. Within one run we don't create campaigns under
 * not-yet-approved accounts — that gap is absorbed by the weekly cycle.
 *
 * Match rule: by folder_id only. Never name-fuzzy-match. If a folder name
 * coincidentally matches an existing account with drive_folder_id=NULL, we
 * create a new-entity proposal and let the owner reject as a duplicate.
 * This is a deliberate "air gap is the human" choice.
 */

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { parseLlmJson, runPreset } from '../ai';
import { listFolderChildren } from './client';
import { extractText } from './extract';
import { interpretFile } from './interpret';
import { writeScanLog } from './logs';
import {
  ACCOUNT_WRITABLE_FIELDS,
  CAMPAIGN_WRITABLE_FIELDS,
  buildAccountCurrentState,
  validateProposedValue,
  type AccountCurrentState,
  type AccountWritableField,
  type CampaignCurrentState,
  type CampaignWritableField,
} from './schema';
import { newEntityResponseSchema } from './structured-output';
import type { TraversedFile } from './types';

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * How many files we'll open inside a candidate folder to build LLM context.
 *
 * Lowered from 5 → 2 per D13: folders existing for hours/days with one or
 * two files (typical: brief + transcript) should trigger detection. The
 * cap also bounds per-file interpretation cost during discovery — for
 * every candidate folder that *is* an entity we make this many extra
 * interpretation calls, so keeping it tight matters.
 */
const DISCOVERY_FILE_BUDGET = 2;

/**
 * Empty current-state shape passed to interpretFile during discovery. The
 * per-file extractor ignores current state in the prompt (it's a pure
 * content extractor — see drive.interpret.ts header), so we satisfy the
 * type with null-valued fields without faking data the entity doesn't
 * have yet.
 */
const EMPTY_ACCOUNT_STATE: AccountCurrentState = {
  status: null,
  account_exec_staff_id: null,
  industry: null,
  primary_contact_name: null,
  primary_contact_email: null,
  notes: null,
};

const EMPTY_CAMPAIGN_STATE: CampaignCurrentState = {
  status: null,
  budget: null,
  awarded_at: null,
  live_at: null,
  ends_at: null,
};

// ── LLM response validation ────────────────────────────────────────────────

const ProposalSchema = z
  .object({
    name: z.string(),
  })
  .catchall(z.union([z.string(), z.null()]).optional());

const NewEntityResponseSchema = z.object({
  is_entity: z.boolean(),
  skip_reason: z.string().nullable().optional(),
  proposal: ProposalSchema.nullable().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

type NewEntityResponse = z.infer<typeof NewEntityResponseSchema>;

// ── Public entrypoint ──────────────────────────────────────────────────────

export interface DiscoverInput {
  syncRunId: string | null;
  /**
   * Review notification recipient for proposals where we don't yet have an
   * account owner (top-level new accounts). Falls through to the account
   * owner for new-campaign proposals since the parent account exists.
   */
  defaultReviewerEmail?: string | null;
  defaultReviewerStaffId?: string | null;
}

export interface DiscoverResult {
  accountsProposed: number;
  campaignsProposed: number;
  foldersSkipped: number;
  llmDriver: string;
}

export async function discoverNewEntities(input: DiscoverInput): Promise<DiscoverResult> {
  const rootFolderId = config.DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) {
    logger.warn('[drive.discover] DRIVE_ROOT_FOLDER_ID unset — discovery is a no-op');
    return { accountsProposed: 0, campaignsProposed: 0, foldersSkipped: 0, llmDriver: 'n/a' };
  }

  const result: DiscoverResult = {
    accountsProposed: 0,
    campaignsProposed: 0,
    foldersSkipped: 0,
    llmDriver: 'unknown',
  };

  // ── Pass 1: new-account discovery under the root ─────────────────────────
  const topLevel = await listChildFolders(rootFolderId);
  const existingAccountFolderIds = new Set(
    (await prisma.account.findMany({
      where: { driveFolderId: { not: null } },
      select: { driveFolderId: true },
    }))
      .map((a) => a.driveFolderId)
      .filter((v): v is string => !!v),
  );

  for (const folder of topLevel) {
    if (existingAccountFolderIds.has(folder.id)) continue; // already linked
    const outcome = await proposeNewEntity({
      entityType: 'account',
      folder,
      accountId: null,
      parentAccountState: null,
      parentAccountName: null,
      syncRunId: input.syncRunId,
      reviewerEmail: input.defaultReviewerEmail ?? null,
      reviewerStaffId: input.defaultReviewerStaffId ?? null,
    });
    if (outcome.status === 'proposed') result.accountsProposed++;
    else result.foldersSkipped++;
    result.llmDriver = outcome.driver;
  }

  // ── Pass 2: new-campaign discovery inside each already-linked account ────
  const linkedAccounts = await prisma.account.findMany({
    where: { driveFolderId: { not: null } },
    include: { owner: { select: { id: true, email: true } } },
  });

  for (const account of linkedAccounts) {
    const folderId = account.driveFolderId;
    if (!folderId) continue;

    let subfolders: TraversedFile[] = [];
    try {
      subfolders = await listChildFolders(folderId);
    } catch (err) {
      logger.error({ err, accountId: account.id }, '[drive.discover] listChildFolders failed');
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: account.id,
        level: 'error',
        category: 'traversal_error',
        message: err instanceof Error ? err.message : String(err),
        payload: { pass: 'campaign_discovery', folderId },
      });
      continue;
    }

    const existingCampaignFolderIds = new Set(
      (await prisma.campaign.findMany({
        where: { accountId: account.id, driveFolderId: { not: null } },
        select: { driveFolderId: true },
      }))
        .map((c) => c.driveFolderId)
        .filter((v): v is string => !!v),
    );

    const parentState = buildAccountCurrentState(account);
    const reviewer = {
      email: account.owner?.email ?? input.defaultReviewerEmail ?? null,
      staffId: account.owner?.id ?? input.defaultReviewerStaffId ?? null,
    };

    for (const folder of subfolders) {
      if (existingCampaignFolderIds.has(folder.id)) continue;
      const outcome = await proposeNewEntity({
        entityType: 'campaign',
        folder,
        accountId: account.id,
        parentAccountState: parentState,
        parentAccountName: account.name,
        syncRunId: input.syncRunId,
        reviewerEmail: reviewer.email,
        reviewerStaffId: reviewer.staffId,
      });
      if (outcome.status === 'proposed') result.campaignsProposed++;
      else result.foldersSkipped++;
      result.llmDriver = outcome.driver;
    }
  }

  return result;
}

// ── Core: propose one new entity from one folder ───────────────────────────

interface ProposeInput {
  entityType: 'account' | 'campaign';
  folder: TraversedFile;
  /** For campaign proposals: the parent account. For account proposals: null. */
  accountId: string | null;
  parentAccountState: Record<string, unknown> | null;
  /**
   * For campaign proposals: the parent account's display name (passed to
   * per-file interpretation so observations frame the campaign correctly).
   * Null for top-level account proposals.
   */
  parentAccountName: string | null;
  syncRunId: string | null;
  reviewerEmail: string | null;
  reviewerStaffId: string | null;
}

interface ProposeOutcome {
  status: 'proposed' | 'skipped';
  driver: string;
  reason?: string;
}

async function proposeNewEntity(input: ProposeInput): Promise<ProposeOutcome> {
  // Gather bounded file context from inside the folder (up to DISCOVERY_FILE_BUDGET files).
  const sample = await sampleFolderFiles(input.folder.id, input.folder.path);
  if (sample.snippets.length === 0) {
    logger.info(
      { folderId: input.folder.id, folderName: input.folder.name },
      '[drive.discover] folder has no extractable files — proposing with folder metadata alone',
    );
  }

  const preset = await runPreset({
    key: 'drive.new_entity_extraction.v1',
    responseSchema: newEntityResponseSchema(input.entityType),
    variables: {
      entity_type: input.entityType,
      folder_name: input.folder.name,
      folder_path: input.folder.path,
      folder_id: input.folder.id,
      parent_account_state_json: input.parentAccountState
        ? JSON.stringify(input.parentAccountState, null, 2)
        : '(no parent — this is a top-level account proposal)',
      file_sample_json: JSON.stringify(sample.snippets, null, 2),
      writable_fields_json: JSON.stringify(
        input.entityType === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS,
      ),
    },
  });

  let parsed: NewEntityResponse;
  try {
    const raw = parseLlmJson(preset.text);
    parsed = NewEntityResponseSchema.parse(raw);
  } catch (err) {
    logger.error(
      { err, folderId: input.folder.id, raw: preset.text.slice(0, 400) },
      '[drive.discover] LLM response parse failed',
    );
    await writeScanLog({
      syncRunId: input.syncRunId,
      accountId: input.accountId,
      level: 'error',
      category: 'llm_error',
      message: 'New-entity LLM response could not be parsed',
      payload: { folderId: input.folder.id, rawPreview: preset.text.slice(0, 400) },
    });
    return { status: 'skipped', driver: preset.driver, reason: 'parse_failed' };
  }

  if (!parsed.is_entity || !parsed.proposal) {
    await writeScanLog({
      syncRunId: input.syncRunId,
      accountId: input.accountId,
      level: 'info',
      category: 'diagnostic',
      message: `Folder "${input.folder.name}" not proposed as ${input.entityType}: ${parsed.skip_reason ?? 'LLM declined'}`,
      payload: {
        folderId: input.folder.id,
        folderPath: input.folder.path,
        reasoning: parsed.reasoning,
        confidence: parsed.confidence,
      },
    });
    return { status: 'skipped', driver: preset.driver, reason: parsed.skip_reason ?? 'not_entity' };
  }

  // Validate every proposed field value. Invalid values → drop + log.
  const groupId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.DRIVE_PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000);
  const writableFields: readonly string[] =
    input.entityType === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS;

  // Build the list of (property, proposedValue) pairs to insert.
  // Always insert the `name` row — required by the DB — plus one row per valid
  // writable-field proposal.
  const rows: Array<{ property: string; proposedValue: Prisma.InputJsonValue | null }> = [];

  rows.push({ property: 'name', proposedValue: parsed.proposal.name });

  for (const field of writableFields) {
    const raw = parsed.proposal[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const validation = validateProposedValue(input.entityType, field, raw);
    if (!validation.ok) {
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: input.accountId,
        level: 'warn',
        category: 'ambiguous',
        message: `New-${input.entityType} proposal: invalid ${field}: ${validation.reason}`,
        payload: { folderId: input.folder.id, rawProposed: raw },
      });
      continue;
    }
    rows.push({
      property: field,
      proposedValue: (validation.value ?? null) as Prisma.InputJsonValue | null,
    });
  }

  // Phase 7: collect per-file observations for the matching entity type.
  // Synchronous w.r.t. the proposal write — we want the additional_update
  // row landing in the same logical batch so the reviewer sees one card
  // (group + attached observations) and so applyGroupDecision can apply
  // both atomically. Failures here are non-fatal: a discovery without
  // observations still proposes the entity; v1 status_markdown will just
  // be sparser.
  let observationItems: Array<{ text: string; source_file_ids: string[] }> = [];
  if (sample.sampledFiles.length > 0) {
    const accountNameForInterp =
      input.entityType === 'account'
        ? parsed.proposal.name
        : input.parentAccountName ?? '(unknown account)';
    const campaignNameForInterp =
      input.entityType === 'campaign' ? parsed.proposal.name : null;
    try {
      observationItems = await collectDiscoveryObservations({
        entityType: input.entityType,
        accountName: accountNameForInterp,
        campaignName: campaignNameForInterp,
        sampledFiles: sample.sampledFiles,
      });
    } catch (err) {
      logger.warn(
        { err, folderId: input.folder.id, entityType: input.entityType },
        '[drive.discover] discovery observation pass failed — proposing entity without attached observations',
      );
    }
  }

  // Write all rows under one proposal_group_id. If observations exist,
  // append a single additional_update row sharing the group id so the
  // reviewer UI can render both in one card and applyGroupDecision can
  // apply both atomically (Phase 7b).
  await prisma.$transaction([
    ...rows.map((row) =>
      prisma.driveChangeProposal.create({
        data: {
          kind: 'new_entity',
          proposalGroupId: groupId,
          sourceDriveFolderId: input.folder.id,
          syncRunId: input.syncRunId,
          entityType: input.entityType,
          accountId: input.accountId, // null for account-kind, parent id for campaign-kind
          campaignId: null,
          property: row.property,
          currentValue: Prisma.JsonNull,
          proposedValue:
            row.proposedValue === null
              ? Prisma.JsonNull
              : (row.proposedValue as Prisma.InputJsonValue),
          reasoning: parsed.reasoning,
          sourceFileIds: sample.fileIds,
          confidence: new Prisma.Decimal(parsed.confidence),
          state: 'pending',
          reviewToken: crypto.randomBytes(32).toString('hex'),
          reviewerEmail: input.reviewerEmail,
          reviewerStaffId: input.reviewerStaffId,
          expiresAt,
        },
      }),
    ),
    ...(observationItems.length > 0
      ? [
          prisma.driveChangeProposal.create({
            data: {
              kind: 'additional_update',
              proposalGroupId: groupId,
              sourceDriveFolderId: input.folder.id,
              syncRunId: input.syncRunId,
              entityType: input.entityType,
              accountId: input.accountId,
              campaignId: null,
              // Sentinel — additional_update rows don't target a column.
              property: '__note__',
              currentValue: Prisma.JsonNull,
              proposedValue: { items: observationItems } as Prisma.InputJsonValue,
              reasoning: null,
              sourceFileIds: Array.from(
                new Set(observationItems.flatMap((it) => it.source_file_ids)),
              ),
              confidence: null,
              state: 'pending',
              reviewToken: crypto.randomBytes(32).toString('hex'),
              reviewerEmail: input.reviewerEmail,
              reviewerStaffId: input.reviewerStaffId,
              expiresAt,
            },
          }),
        ]
      : []),
  ]);

  logger.info(
    {
      folderId: input.folder.id,
      entityType: input.entityType,
      groupId,
      rows: rows.length,
      observations: observationItems.length,
      confidence: parsed.confidence,
    },
    '[drive.discover] emitted new-entity proposal',
  );

  return { status: 'proposed', driver: preset.driver };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function listChildFolders(folderId: string): Promise<TraversedFile[]> {
  const children = await listFolderChildren(folderId);
  return children
    .filter((c) => c.mimeType === GOOGLE_FOLDER_MIME && c.id && c.name)
    .map((c) => ({
      id: c.id as string,
      name: c.name as string,
      mimeType: c.mimeType as string,
      ...(c.parents ? { parents: c.parents } : {}),
      path: c.name as string,
      modifiedTime: c.modifiedTime ?? null,
      modifiedByEmail: c.lastModifyingUser?.emailAddress ?? null,
      createdTime: c.createdTime ?? null,
      size: null,
      isFolder: true,
    }));
}

interface SampledFile {
  file: TraversedFile;
  /** Full extracted text — fed to per-file interpretation. */
  fullText: string;
  /** Truncated copy of the same text — fed to the new-entity LLM prompt. */
  textPreview: string;
}

interface FolderSample {
  snippets: Array<{ name: string; path: string; textPreview: string }>;
  fileIds: string[];
  /**
   * Full per-file extraction results — used by Phase 7 to run per-file
   * interpretation AFTER the new-entity LLM call confirms this is an
   * entity. Keeps the (small) full-text payloads around so we don't have
   * to re-extract.
   */
  sampledFiles: SampledFile[];
}

/**
 * Pull up to DISCOVERY_FILE_BUDGET files from this folder (one level deep)
 * and return short text snippets for the new-entity LLM call PLUS the full
 * extracted text per file for downstream interpretation (Phase 7).
 */
async function sampleFolderFiles(folderId: string, folderPath: string): Promise<FolderSample> {
  const children = await listFolderChildren(folderId);
  const files = children.filter((c) => c.mimeType !== GOOGLE_FOLDER_MIME && c.id && c.name);

  const snippets: FolderSample['snippets'] = [];
  const fileIds: string[] = [];
  const sampledFiles: SampledFile[] = [];

  for (const f of files) {
    if (snippets.length >= DISCOVERY_FILE_BUDGET) break;
    const traversed: TraversedFile = {
      id: f.id as string,
      name: f.name as string,
      mimeType: f.mimeType as string,
      ...(f.parents ? { parents: f.parents } : {}),
      path: `${folderPath} / ${f.name}`,
      modifiedTime: f.modifiedTime ?? null,
      modifiedByEmail: f.lastModifyingUser?.emailAddress ?? null,
      createdTime: f.createdTime ?? null,
      size: f.size ? Number(f.size) : null,
      isFolder: false,
    };
    try {
      const outcome = await extractText(traversed);
      if (outcome.kind === 'ok' && outcome.text.trim().length > 0) {
        const textPreview = outcome.text.slice(0, 2000);
        snippets.push({
          name: traversed.name,
          path: traversed.path,
          textPreview,
        });
        fileIds.push(traversed.id);
        sampledFiles.push({
          file: traversed,
          fullText: outcome.text,
          textPreview,
        });
      }
    } catch (err) {
      logger.warn(
        { err, fileId: traversed.id },
        '[drive.discover] extractText failed during folder sampling',
      );
    }
  }

  return { snippets, fileIds, sampledFiles };
}

/**
 * Phase 7: after confirming this folder represents a new entity, run
 * per-file interpretation on the sampled files and collect observations
 * of the matching entity type. Each observation becomes an item in the
 * additional_update row attached to the new-entity proposal group.
 *
 * Per-file interpretation runs in parallel (up to DISCOVERY_FILE_BUDGET
 * concurrent calls — currently 2, so no rate-limit concern). Errors on
 * one file don't abort the others; we just skip that file's observations.
 *
 * The per-file extractor produces BOTH account and campaign observations
 * for every file. For a new-account proposal we keep only account obs
 * (campaign obs are speculative — no specific campaign exists yet). For
 * a new-campaign proposal we keep only campaign obs. The discarded set
 * is fine to drop: those observations would have no home in a single-
 * entity creation transaction.
 */
async function collectDiscoveryObservations(args: {
  entityType: 'account' | 'campaign';
  accountName: string;
  campaignName: string | null;
  sampledFiles: SampledFile[];
}): Promise<Array<{ text: string; source_file_ids: string[] }>> {
  const results = await Promise.all(
    args.sampledFiles.map(async (sf) => {
      try {
        const out = await interpretFile({
          file: sf.file,
          text: sf.fullText,
          accountName: args.accountName,
          accountCurrentState: EMPTY_ACCOUNT_STATE,
          campaignName: args.campaignName,
          campaignCurrentState: args.entityType === 'campaign' ? EMPTY_CAMPAIGN_STATE : null,
          // Discovery is a single-entity sample pass — no multi-campaign
          // attribution. Pass the candidate's own name (when known) so
          // the LLM has consistent tagging vocabulary.
          knownCampaigns: args.campaignName ? [args.campaignName] : [],
        });
        const picked = args.entityType === 'account' ? out.account : out.campaign;
        return picked.map((obs) => ({
          text: obs.text,
          source_file_ids: [sf.file.id],
        }));
      } catch (err) {
        logger.warn(
          { err, fileId: sf.file.id },
          '[drive.discover] interpretFile failed during discovery observation pass — skipping',
        );
        return [];
      }
    }),
  );
  return results.flat();
}

// Re-export types that callers might want.
export type { AccountWritableField, CampaignWritableField };
