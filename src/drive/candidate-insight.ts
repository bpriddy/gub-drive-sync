// D2 (#38): candidate-insight assembly over the scan-core distillation
// output. Pure post-processing — the Stage-2 attributor already decided
// each entity's scope (the Target), and distillation already emitted
// notes + field_changes with provenance; this module just reshapes the
// two into the D1/B3 insight contract so D3 (embed → retrieve →
// reconcile) consumes candidates unchanged. NO LLM call, NO persistence,
// NO embedding here — those are D4/D3.
//
// Kept out of schema.ts (mirrored/lockstep with gcp-universal-backend)
// and structured-output.ts (LLM response schemas) on purpose: the
// candidate shape is a consumer contract, not a prompt contract.
import { z } from 'zod';

/**
 * Notes in drive.distillation.v1 carry no confidence — only
 * field_changes do. Default the notes half to a deliberately neutral
 * value rather than fabricating high confidence; adding a real
 * confidence to the notes output is a later prompt edit, not D2.
 */
export const NOTE_DEFAULT_CONFIDENCE = 0.5;

/**
 * The D1/B3 insight-candidate contract.
 *
 * - `accountId` — owning account = RLS/scope anchor (D1 insights.account_id).
 * - `entityId` — account id | campaign id (existing) | campaignFolderId
 *   (new candidate). A NEW campaign has no DB row yet, so its entityId is
 *   a Drive folder ref (decoupled external-id pattern, same as the ideas
 *   tier) — D3/D4 resolve it to a campaign row at reconcile/apply time.
 * - `sourceFileIds` — provenance, never empty (the A1 lesson).
 * - `confidence` — 0..1 here; convert to Decimal(3,2) only at D4 persist.
 */
export const CandidateInsightSchema = z.object({
  accountId: z.string(),
  entityType: z.enum(['account', 'campaign']),
  entityId: z.string(),
  entityStatus: z.enum(['existing', 'new']).optional(),
  text: z.string().min(1),
  sourceFileIds: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
  origin: z.enum(['field_change', 'note']),
});

export type CandidateInsight = z.infer<typeof CandidateInsightSchema>;

// Structural mirrors of the scan-core shapes (Target in process-batch.ts,
// runDistillation's return in persist.ts) so this module stays free of
// prisma/scan imports and the unit suite stays hermetic.

export interface CandidateTarget {
  /** Owning account id (EntityCtx.accountId) — always set, even on campaign scans. */
  accountId: string;
  entityType: 'account' | 'campaign' | 'piece';
  entityStatus: 'account' | 'existing' | 'new' | 'piece';
  /** Account/campaign DB id; null for new candidates (no row yet). */
  entityId: string | null;
  /** Campaign-root folder id — the external ref for NEW candidates. */
  campaignFolderId: string | null;
  entityName: string;
}

export interface DistilledFieldChange {
  field: string;
  proposed_value?: string | null | undefined;
  reasoning: string;
  source_file_ids: string[];
  confidence: number;
}

export interface DistilledNote {
  text: string;
  source_file_ids: string[];
}

export interface CandidateDistillResult {
  field_changes: DistilledFieldChange[];
  notes: DistilledNote[];
}

type CandidateScope = Pick<CandidateInsight, 'entityType' | 'entityId' | 'entityStatus'>;

// The Target IS the entity slot — scope is read off it, never re-derived.
// Returns null when the target can't anchor a candidate:
//   - pieces: distillation is skipped for them upstream (markdown-only);
//     piece/idea insights are the separate idea-extraction tier.
//   - phantom new candidates (campaignFolderId null): no stable external
//     ref exists until persist creates the row — nothing D3 could
//     reconcile against.
function resolveScope(target: CandidateTarget, warn: (message: string) => void): CandidateScope | null {
  if (target.entityType === 'account') {
    return { entityType: 'account', entityId: target.accountId };
  }
  if (target.entityType === 'campaign') {
    if (target.entityStatus === 'new') {
      if (!target.campaignFolderId) {
        warn(
          `candidates: skipped for phantom candidate "${target.entityName}" — no campaignFolderId to anchor entityId`,
        );
        return null;
      }
      return { entityType: 'campaign', entityId: target.campaignFolderId, entityStatus: 'new' };
    }
    if (!target.entityId) {
      warn(
        `candidates: skipped for campaign "${target.entityName}" — existing campaign without a DB id`,
      );
      return null;
    }
    return { entityType: 'campaign', entityId: target.entityId, entityStatus: 'existing' };
  }
  return null;
}

function renderFieldChangeText(fc: DistilledFieldChange): string {
  const value = fc.proposed_value ?? '(null)';
  return fc.reasoning ? `${fc.field} → ${value} (${fc.reasoning})` : `${fc.field} → ${value}`;
}

/**
 * Assemble candidate insights from one target's distilled output.
 *
 * Deliberately total: a malformed candidate is warned about and dropped,
 * never thrown — this runs inside synthesizeTarget's distill try-block,
 * and a throw there would discard the entity's field changes with it.
 * Empty provenance (A1) is warned about explicitly rather than emitted.
 */
export function toCandidateInsights(
  target: CandidateTarget,
  distillResult: CandidateDistillResult,
  warn: (message: string) => void = () => {},
): CandidateInsight[] {
  const scope = resolveScope(target, warn);
  if (!scope) return [];

  const candidates: CandidateInsight[] = [];
  const push = (raw: Omit<CandidateInsight, keyof CandidateScope | 'accountId'>): void => {
    if (raw.sourceFileIds.length === 0) {
      warn(
        `candidates: dropped ${raw.origin} "${raw.text.slice(0, 60)}" — empty sourceFileIds (A1: provenance must be non-empty)`,
      );
      return;
    }
    const parsed = CandidateInsightSchema.safeParse({
      accountId: target.accountId,
      ...scope,
      ...raw,
    });
    if (!parsed.success) {
      warn(`candidates: dropped ${raw.origin} — ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      return;
    }
    candidates.push(parsed.data);
  };

  for (const fc of distillResult.field_changes) {
    push({
      text: renderFieldChangeText(fc),
      sourceFileIds: fc.source_file_ids,
      confidence: fc.confidence,
      origin: 'field_change',
    });
  }
  for (const note of distillResult.notes) {
    push({
      text: note.text,
      sourceFileIds: note.source_file_ids,
      confidence: NOTE_DEFAULT_CONFIDENCE,
      origin: 'note',
    });
  }
  return candidates;
}
