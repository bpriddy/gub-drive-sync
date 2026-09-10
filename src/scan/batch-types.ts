// Part of the scan core (src/scan/) — mode-agnostic batch machinery shared
// by every driver (day-walk backfill today; the Activity forward driver next).
import type {
  AccountCurrentState,
  CampaignCurrentState,
} from '../drive/schema';
import type { CampaignObservation } from '../drive/interpret';
import type { EntityMap } from '../drive/structure';
import type { IdeaScanStats } from '../drive/idea-scan';
import type { CandidateInsight } from '../drive/candidate-insight';

// ── Per-batch processing ────────────────────────────────────────────────────

/**
 * The scan's entity context — account/campaign identity, current state,
 * dossiers, and the driver-owned cursor/cache fields. Constructed by the
 * DRIVER (src/backfill/entity.ts loadEntity today; the forward driver
 * later) and consumed read-only by the scan core.
 */
export interface EntityCtx {
  type: 'account' | 'campaign';
  id: string;
  name: string;
  folderId: string;
  /**
   * The parent account id for both account- and campaign-scoped ctx —
   * the bootstrap cursor lives on `accounts.drive_bootstrap_cursor` and
   * is account-scoped regardless of which entity drove the chunk.
   */
  accountId: string;
  /** Account ROOT folder id — the org-scope external key on idea rows. */
  accountFolderId: string | null;
  accountState: AccountCurrentState;
  accountName: string;
  campaignName: string | null;
  campaignState: CampaignCurrentState | null;
  /** Current persisted status_markdown (general) or null. */
  statusMarkdown: string | null;
  /** Current persisted status_sensitive_markdown or null (per D29). */
  statusSensitiveMarkdown: string | null;
  /**
   * Persisted `accounts.drive_bootstrap_cursor` as YYYY-MM-DD, or null.
   * Drives the modifiedTime-day walker's "next pending day" lookup.
   * Written at the end of every chunk regardless of synthesis output.
   */
  driveBootstrapCursor: string | null;
  /**
   * Cached structure (folders + entity_map + fingerprint) from a prior
   * chunk. NULL = first chunk in chain, or cache invalidated. Engine
   * checks fingerprint; on match, skips the ~1m 45s LLM classify step.
   */
  driveStructureClassification: unknown;
  /**
   * Cached file list + active_dates from bootstrap chunk #1. NULL after
   * bootstrap completes (or before first chunk). When present, chunks
   * 2..N skip the ~3 min file discovery + grouping step.
   */
  driveBootstrapFiles: unknown;
  reviewerEmail: string | null;
  reviewerStaffId: string | null;
}

export interface CampaignBucket {
  campaignName: string;
  /**
   * Drive folder id for campaigns that have one (existing campaigns +
   * structure-discovered new candidates). NULL for phantom-name
   * candidates — where the per-file LLM emitted an entity_campaign_name
   * that didn't match any known campaign by exact or similarity match.
   * Those candidates become folder-less Campaign rows on persist.
   */
  campaignFolderId: string | null;
  campaignStatus: 'existing' | 'new';
  matchedCampaignId: string | null;
  /**
   * Origin of the bucket. Drives idempotency strategy at persist time:
   *   - 'folder'  → dedup by driveFolderId (existing path)
   *   - 'phantom' → dedup by case-insensitive name+accountId
   */
  bucketSource: 'folder' | 'phantom';
  observations: Array<{ observation: CampaignObservation; sourceFileId: string }>;
  fileIds: Set<string>;
}

/**
 * Name → bucket-routing hint built from the entity map. Used during
 * processBatch's per-file routing to resolve a tag (entity_campaign_name
 * emitted by the per-file LLM) to a concrete bucket key.
 */
export interface CampaignNameDirectory {
  /** All campaign names known to the structure scan (existing + new), verbatim. */
  knownCampaignNames: string[];
  /** name (case-insensitive) → existing campaign db id */
  existingByName: Map<string, { campaignId: string; folderId: string; name: string }>;
  /** name (case-insensitive) → new-candidate folder id (from structure scan) */
  newFolderByName: Map<string, { folderId: string; name: string }>;
}

export function buildCampaignNameDirectory(
  entityMap: EntityMap,
  existingCampaigns: Array<{ id: string; name: string; driveFolderId: string }>,
): CampaignNameDirectory {
  const existingByName = new Map<string, { campaignId: string; folderId: string; name: string }>();
  for (const c of existingCampaigns) {
    existingByName.set(c.name.trim().toLowerCase(), {
      campaignId: c.id,
      folderId: c.driveFolderId,
      name: c.name,
    });
  }
  const newFolderByName = new Map<string, { folderId: string; name: string }>();
  for (const cf of entityMap.classified) {
    if (cf.classification === 'new_campaign' && cf.campaignName) {
      newFolderByName.set(cf.campaignName.trim().toLowerCase(), {
        folderId: cf.folderId,
        name: cf.campaignName,
      });
    }
  }
  // Vocabulary the per-file LLM gets — union of existing + new-candidate names.
  const knownCampaignNames = [
    ...existingCampaigns.map((c) => c.name),
    ...entityMap.classified
      .filter((cf) => cf.classification === 'new_campaign' && !!cf.campaignName)
      .map((cf) => cf.campaignName!),
  ];
  return { knownCampaignNames, existingByName, newFolderByName };
}

/** Stage 3: per-entity distill+synth output, one entry per entity touched. */
export interface EntitySynthesisResult {
  entityType: 'account' | 'campaign' | 'piece';
  entityName: string;
  /**
   * Status of the entity at synthesis time:
   * - 'account': it's the account itself.
   * - 'existing': existing campaign (matched to a DB row).
   * - 'new': new campaign candidate (no DB row yet — distill is skipped).
   */
  entityStatus: 'account' | 'existing' | 'new' | 'piece';
  observationsCount: number;
  filesCount: number;
  distillResult: {
    proposalsCreated: number;
    notesWritten: number;
    ambiguousWritten: number;
    driver: string;
  } | null;
  synthesizedMarkdown: string;
  /** Sensitive companion blob, null when no sensitive content this scan. */
  synthesizedSensitiveMarkdown: string | null;
  synthesisMs: number;
  /**
   * D2 (#38): zod-validated candidate insights assembled from this
   * entity's distilled output, scoped by its Target. In-memory only —
   * persistence is D4, embedding D3. Empty for pieces (distillation
   * skipped) and when distillation failed.
   */
  candidates: CandidateInsight[];
}

export interface BatchOutcome {
  filesAttempted: number;
  filesExtracted: number;
  filesSkipped: number;
  filesErrored: number;
  filesZeroObs: number;
  accountObsTotal: number;
  campaignObsTotal: number;
  /** Stage 2: per-campaign observation breakdown (account scans only). */
  campaignBuckets: CampaignBucket[];
  /** Files attributed directly to the account (not inside any campaign). */
  accountLevelFiles: number;
  /** Campaign-bucket observations dropped because the file is account-level. */
  campaignObsDiscarded: number;
  /** Stage 3: one entry per entity that got distill+synth. */
  synthesized: EntitySynthesisResult[];
  /** D2 (#38): all entities' candidate insights, flattened. In-memory only. */
  candidates: CandidateInsight[];
  /**
   * Stage-3 synthesis/apply/propose failures. Non-zero means at least
   * one entity's day did NOT land (in the DB or the review queue) —
   * run.ts throws before the cursor persists so the queue retry re-runs
   * the day instead of silently losing it. Distill failures are
   * deliberately excluded (degraded, not lost).
   */
  stage3Failures: number;
  /** Ideas tier: deck-gated extraction stats (null when account folder unknown). */
  ideaStats: IdeaScanStats | null;
}
