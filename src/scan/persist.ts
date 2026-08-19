// Part of the scan core (src/scan/) — mode-agnostic batch machinery shared
// by every driver (day-walk backfill today; the Activity forward driver next).
import { z } from 'zod';
import { prisma } from '../prisma';
import {
  ACCOUNT_WRITABLE_FIELDS,
  CAMPAIGN_WRITABLE_FIELDS,
  type AccountCurrentState,
  type CampaignCurrentState,
  type FieldWriteSpec,
} from '../drive/schema';
import { distillationResponseSchema } from '../drive/structured-output';
import { parseLlmJson, runPreset } from '../ai';
import { DRIVE_SYNC_SYSTEM_STAFF_ID, castToEntity, projectChangeValue } from '../drive/heal';
import type { AccountObservation, CampaignObservation } from '../drive/interpret';
import { log } from './output';
import type { EntityCtx } from './batch-types';


// ── Distillation (the engine's structured-field step) ───────────────────────
//
// Runs the drive.distillation.v1 preset over an entity's observation bucket
// and returns structured field_changes + notes. Pure LLM call — writes
// nothing; persistTarget applies the results (auto-apply, system-staff
// attribution). Named runDryRunDistillation historically because it began
// as the dry-run path; it has been the production distillation step since
// auto-apply shipped. (The v1 pipeline's distillAndEmit writes review
// proposals instead — that is its difference, not this one's.)

const DistillationSchema = z.object({
  field_changes: z
    .array(
      z.object({
        field: z.string(),
        proposed_value: z.string().nullable().optional(),
        reasoning: z.string(),
        source_file_ids: z.array(z.string()).default([]),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  notes: z
    .array(
      z.object({
        text: z.string(),
        source_file_ids: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  ambiguous: z
    .array(
      z.object({
        text: z.string(),
        source_file_ids: z.array(z.string()).default([]),
        reasoning: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export async function runDistillation(
  entityType: 'account' | 'campaign',
  observations: Array<{
    observation: AccountObservation | CampaignObservation;
    sourceFileId: string;
  }>,
  currentState: AccountCurrentState | CampaignCurrentState,
  /**
   * Facts this entity has ALREADY captured — stored Context/Transient
   * bullets plus note items already awaiting review. The prompt suppresses
   * notes that merely restate one of these (contradictions still emit —
   * that's how the record gets corrected).
   *
   * Empty on the auto-apply path, where synthesis's own merge already
   * dedupes against the prior doc in the same pass. Only the propose path
   * needs this, because review sits between distillation and synthesis.
   */
  knownFacts: string[] = [],
): Promise<{
  field_changes: z.infer<typeof DistillationSchema>['field_changes'];
  notes: z.infer<typeof DistillationSchema>['notes'];
  driver: string;
}> {
  const observationsForPrompt = observations.map((o) => ({
    ...o.observation,
    source_file_id: o.sourceFileId,
  }));

  const completion = await runPreset({
    key: 'drive.distillation.v1',
    responseSchema: distillationResponseSchema(entityType),
    variables: {
      entity_type: entityType,
      writable_fields_json: JSON.stringify(
        entityType === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS,
      ),
      observations_json: JSON.stringify(observationsForPrompt, null, 2),
      current_state_json: JSON.stringify(currentState, null, 2),
      known_facts_json: JSON.stringify(knownFacts, null, 2),
    },
  });

  const parsed = parseLlmJson<unknown>(completion.text);
  const validated = DistillationSchema.parse(parsed);
  return {
    field_changes: validated.field_changes,
    notes: validated.notes,
    driver: completion.driver,
  };
}

// ── Apply helpers (cast + project to *_changes column shape) ─────────────────
//
// Shared with the heal step: castToEntity + projectChangeValue live in
// src/drive/heal.ts (which mirrors gcp-universal-backend's drive.review.ts
// apply path), so scan-apply, heal, and reviewer approval all produce
// identical audit rows + entity-column shapes. The only differences are
// changed_by (system staff here, reviewer there) and the lack of a
// drive_change_proposals row to reference.

export interface ValidatedChange {
  field: string;
  spec: FieldWriteSpec;
  validatedValue: unknown;
  previousValue: unknown;
  /** Raw string form of proposed_value, used to populate state for synthesis. */
  proposedValueRaw: string | null;
  confidence: number;
  /**
   * The LLM's justification for this change. Carried so the propose path
   * can show a reviewer WHY a value is being suggested — a field_change
   * card with a bare value and no reasoning is close to unreviewable.
   */
  reasoning: string | null;
  /** Drive file ids the change was derived from — the reviewer's audit trail. */
  sourceFileIds: string[];
}

/** Module-level Target type — used by both processBatch and persistTarget. */
export interface PersistTarget {
  entityType: 'account' | 'campaign' | 'piece';
  entityName: string;
  entityStatus: 'account' | 'existing' | 'new' | 'piece';
  entityId: string | null;
  campaignFolderId: string | null;
  /**
   * Deterministic folder breadcrumb (FolderNode.path) for folder-backed
   * campaign targets; null for account / phantom targets. Persisted to
   * campaign.drive_folder_path so the merge's year gate can read the
   * structural year (the "… / 2026 / …" segment).
   */
  campaignFolderPath: string | null;
}

// ── Apply (persist) a single target's distilled + synthesized result ────────

export async function persistTarget(args: {
  target: PersistTarget;
  ctx: EntityCtx;
  validatedChanges: ValidatedChange[];
  synthesizedMarkdown: string;
  synthesizedSensitiveMarkdown: string | null;
}): Promise<void> {
  const { target, ctx, validatedChanges, synthesizedMarkdown, synthesizedSensitiveMarkdown } = args;

  if (target.entityType === 'piece' && target.entityId) {
    await persistPieceTarget(target.entityId, synthesizedMarkdown, synthesizedSensitiveMarkdown);
    return;
  }
  if (target.entityType === 'account' && target.entityId) {
    await persistAccountTarget(
      target.entityId,
      validatedChanges,
      synthesizedMarkdown,
      synthesizedSensitiveMarkdown,
    );
    return;
  }
  if (target.entityType === 'campaign' && target.entityStatus === 'existing' && target.entityId) {
    await persistExistingCampaignTarget(
      target.entityId,
      validatedChanges,
      synthesizedMarkdown,
      synthesizedSensitiveMarkdown,
      target.campaignFolderPath,
    );
    return;
  }
  if (target.entityType === 'campaign' && target.entityStatus === 'new') {
    if (ctx.type !== 'account') {
      throw new Error('new campaign candidate requires account ctx');
    }
    // Guard: a folder that is already a PIECE of a merged campaign must never
    // be re-created as a campaign (the re-split bug). The piece-anchor overlay
    // routes these upstream, so this firing means attribution missed — prefer
    // NO write over a WRONG one: this target's synthesis was built with a null
    // prior, so writing it onto the owning campaign would clobber the
    // canonical's markdown. Skip and let the next scan route it correctly.
    if (target.campaignFolderId) {
      const piece = await prisma.campaignPiece.findFirst({
        where: { driveFolderId: target.campaignFolderId },
        select: { id: true, campaignId: true },
      });
      if (piece) {
        log(
          `      ⚠ folder ${target.campaignFolderId} is already piece ${piece.id} of campaign ${piece.campaignId} — skipping campaign create (overlay should have routed this)`,
        );
        return;
      }
    }
    // Idempotency: a campaign may already exist for this candidate. Two
    // dedup keys depending on bucket source:
    //   - Folder-backed candidates (structure scan): dedup by driveFolderId
    //   - Phantom-name candidates (campaignFolderId null): dedup by
    //     (accountId, name) case-insensitive — so a phantom obs that
    //     re-emerges on a later scan attaches to the same Campaign row.
    let alreadyCreated: { id: string } | null = null;
    if (target.campaignFolderId) {
      alreadyCreated = await prisma.campaign.findFirst({
        where: { driveFolderId: target.campaignFolderId },
        select: { id: true },
      });
    } else {
      alreadyCreated = await prisma.campaign.findFirst({
        where: {
          accountId: ctx.id,
          name: { equals: target.entityName, mode: 'insensitive' },
        },
        select: { id: true },
      });
    }
    if (alreadyCreated) {
      await persistExistingCampaignTarget(
        alreadyCreated.id,
        validatedChanges,
        synthesizedMarkdown,
        synthesizedSensitiveMarkdown,
        target.campaignFolderPath,
      );
      return;
    }
    await persistNewCampaignTarget({
      accountId: ctx.id,
      campaignName: target.entityName,
      driveFolderId: target.campaignFolderId,
      driveFolderPath: target.campaignFolderPath,
      validatedChanges,
      synthesizedMarkdown,
      synthesizedSensitiveMarkdown,
    });
    return;
  }
  throw new Error(`persistTarget: unsupported target shape (${target.entityType}/${target.entityStatus})`);
}

/**
 * Persist a piece's synthesized markdown. Pieces have no *_changes audit
 * table and no writable structured fields — markdown + last-run only.
 */
async function persistPieceTarget(
  pieceId: string,
  synthesizedMarkdown: string,
  synthesizedSensitiveMarkdown: string | null,
): Promise<void> {
  await prisma.campaignPiece.update({
    where: { id: pieceId },
    data: {
      statusMarkdown: synthesizedMarkdown,
      ...(synthesizedSensitiveMarkdown !== null
        ? { statusSensitiveMarkdown: synthesizedSensitiveMarkdown }
        : {}),
      driveLastRunAt: new Date(),
    },
  });
}

async function persistAccountTarget(
  accountId: string,
  validatedChanges: ValidatedChange[],
  synthesizedMarkdown: string,
  synthesizedSensitiveMarkdown: string | null,
): Promise<void> {
  const columnUpdates: Record<string, unknown> = {};
  for (const vc of validatedChanges) {
    columnUpdates[vc.spec.entityColumn] = castToEntity(vc.spec.changeKind, vc.validatedValue);
  }
  columnUpdates['statusMarkdown'] = synthesizedMarkdown;
  if (synthesizedSensitiveMarkdown !== null) {
    columnUpdates['statusSensitiveMarkdown'] = synthesizedSensitiveMarkdown;
  }

  await prisma.$transaction(async (tx) => {
    await tx.account.update({
      where: { id: accountId },
      data: columnUpdates,
    });
    for (const vc of validatedChanges) {
      const previousCols = projectChangeValue(vc.spec.changeKind, vc.previousValue, 'previous');
      const newCols = projectChangeValue(vc.spec.changeKind, vc.validatedValue, 'new');
      await tx.accountChange.create({
        data: {
          accountId,
          property: vc.field,
          ...previousCols,
          ...newCols,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
    await tx.accountChange.create({
      data: {
        accountId,
        property: 'status_markdown',
        valueText: synthesizedMarkdown,
        changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
      },
    });
    // Per D29: sensitive blob gets its own *_changes row so audit
    // history can be access-gated independently from the general blob.
    if (synthesizedSensitiveMarkdown !== null) {
      await tx.accountChange.create({
        data: {
          accountId,
          property: 'status_sensitive_markdown',
          valueText: synthesizedSensitiveMarkdown,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
  });
}

async function persistExistingCampaignTarget(
  campaignId: string,
  validatedChanges: ValidatedChange[],
  synthesizedMarkdown: string,
  synthesizedSensitiveMarkdown: string | null,
  /** Heals drive_folder_path on rows created before path plumbing existed.
   *  Only written when non-null — never clobbers a real path with null. */
  driveFolderPath?: string | null,
): Promise<void> {
  const columnUpdates: Record<string, unknown> = {};
  for (const vc of validatedChanges) {
    columnUpdates[vc.spec.entityColumn] = castToEntity(vc.spec.changeKind, vc.validatedValue);
  }
  columnUpdates['statusMarkdown'] = synthesizedMarkdown;
  if (synthesizedSensitiveMarkdown !== null) {
    columnUpdates['statusSensitiveMarkdown'] = synthesizedSensitiveMarkdown;
  }
  if (driveFolderPath) {
    columnUpdates['driveFolderPath'] = driveFolderPath;
  }

  await prisma.$transaction(async (tx) => {
    await tx.campaign.update({
      where: { id: campaignId },
      data: columnUpdates,
    });
    for (const vc of validatedChanges) {
      const previousCols = projectChangeValue(vc.spec.changeKind, vc.previousValue, 'previous');
      const newCols = projectChangeValue(vc.spec.changeKind, vc.validatedValue, 'new');
      await tx.campaignChange.create({
        data: {
          campaignId,
          property: vc.field,
          ...previousCols,
          ...newCols,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
    await tx.campaignChange.create({
      data: {
        campaignId,
        property: 'status_markdown',
        valueText: synthesizedMarkdown,
        changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
      },
    });
    if (synthesizedSensitiveMarkdown !== null) {
      await tx.campaignChange.create({
        data: {
          campaignId,
          property: 'status_sensitive_markdown',
          valueText: synthesizedSensitiveMarkdown,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
  });
}

async function persistNewCampaignTarget(args: {
  accountId: string;
  campaignName: string;
  /**
   * Drive folder id for structure-discovered candidates. NULL for
   * phantom-name candidates (per-file LLM emitted a name that didn't
   * exist in the structure scan). Folder-less rows can be linked to a
   * folder later if structure resolution discovers one matching by name.
   */
  driveFolderId: string | null;
  /**
   * Deterministic folder breadcrumb (FolderNode.path). Persisted so the
   * merge's year gate can read the structural year folder ("… / 2026 / …").
   * Null for phantom candidates.
   */
  driveFolderPath: string | null;
  validatedChanges: ValidatedChange[];
  synthesizedMarkdown: string;
  synthesizedSensitiveMarkdown: string | null;
}): Promise<void> {
  const {
    accountId,
    campaignName,
    driveFolderId,
    driveFolderPath,
    validatedChanges,
    synthesizedMarkdown,
    synthesizedSensitiveMarkdown,
  } = args;
  const initialFields: Record<string, unknown> = {};
  for (const vc of validatedChanges) {
    initialFields[vc.spec.entityColumn] = castToEntity(
      vc.spec.changeKind,
      vc.validatedValue,
    );
  }

  await prisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        ...initialFields,
        name: campaignName.trim(),
        accountId,
        createdBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        driveFolderId,
        driveFolderPath,
        statusMarkdown: synthesizedMarkdown,
        ...(synthesizedSensitiveMarkdown !== null
          ? { statusSensitiveMarkdown: synthesizedSensitiveMarkdown }
          : {}),
      },
    });
    await tx.campaignChange.create({
      data: {
        campaignId: created.id,
        property: 'status_markdown',
        valueText: synthesizedMarkdown,
        changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
      },
    });
    if (synthesizedSensitiveMarkdown !== null) {
      await tx.campaignChange.create({
        data: {
          campaignId: created.id,
          property: 'status_sensitive_markdown',
          valueText: synthesizedSensitiveMarkdown,
          changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
        },
      });
    }
  });
}
