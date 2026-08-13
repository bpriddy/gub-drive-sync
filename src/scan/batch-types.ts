// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import type { CampaignObservation } from '../drive/interpret';
import type { EntityMap } from '../drive/structure';
import type { IdeaScanStats } from '../drive/idea-scan';

// ── Per-batch processing ────────────────────────────────────────────────────

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
  /** Ideas tier: deck-gated extraction stats (null when account folder unknown). */
  ideaStats: IdeaScanStats | null;
}
