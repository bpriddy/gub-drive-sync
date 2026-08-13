// Part of the scan core (src/scan/) — mode-agnostic batch machinery shared
// by every driver (day-walk backfill today; the Activity forward driver next).
import { isRateLimitError } from '../drive/client';
import { matchCampaignName } from '../drive/name-similarity';
import type { CampaignObservation } from '../drive/interpret';
import type { EntityAttribution } from '../drive/structure';
import type { CampaignBucket, CampaignNameDirectory } from './batch-types';
import type { CampaignCurrentState } from '../drive/schema';

/**
 * Campaign-scoped scans write ONLY the scanned campaign + its account. An
 * observation whose subject tag resolves to a DIFFERENT campaign is misfiled
 * content (human error — e.g. another project's notes living in this folder);
 * it is DROPPED, not absorbed, so it can't pollute this campaign's dossier.
 * The reviewer step will eventually adjudicate these; for now the loss is
 * accepted by design.
 *
 * Foreignness is judged against the campaign's IDENTITY FAMILY — the
 * scanned campaign's name AND its pieces' names (a merge collapses identity,
 * so "13. Chevy | BHAC AI + LMA Tool" is THIS campaign, not a foreign one).
 * No tag = not foreign (folder-scope default); a tag the fuzzy matcher
 * accepts OR that is contained in / contains any family name (normalized)
 * = ours ("BHAC" must match "02. Chevy | BHAC [GMCHV…]"); anything else is
 * foreign.
 */
export function isForeignCampaignTag(tagRaw: string, ownNames: string[]): boolean {
  const tag = tagRaw.trim();
  if (!tag) return false;
  if (matchCampaignName(tag, ownNames)) return false;
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
  const a = norm(tag);
  if (a.length < 3) return false;
  for (const name of ownNames) {
    const b = norm(name);
    if (b.includes(a) || a.includes(b)) return false;
  }
  return true;
}


/**
 * Synthesized status_markdown for a NEW campaign candidate uses this
 * empty state for the at-a-glance bullets (no DB row exists yet).
 */
export const EMPTY_CAMPAIGN_STATE: CampaignCurrentState = {
  status: null,
  budget: null,
  awarded_at: null,
  live_at: null,
  ends_at: null,
};


type RouteCampaignObsResult =
  | { kind: 'discard' }
  | {
      kind: 'matched';
      via: 'tag-exact' | 'tag-folder' | 'folder' | 'levenshtein';
      similarity: number;
      key: string;
      bucket: CampaignBucket;
    }
  | {
      kind: 'phantom';
      via: 'phantom';
      similarity: number;
      key: string;
      bucket: CampaignBucket;
    };

/**
 * Resolve a single campaign observation to its target bucket. Used by
 * processBatch on every campaign obs in an account-scoped scan (attributor
 * non-null). Returns:
 *   - { kind: 'matched' } — routed to an existing-campaign or new-folder
 *     bucket (via tag-match or folder attribution)
 *   - { kind: 'phantom' } — routed to a phantom-name bucket; persist
 *     creates a folder-less Campaign row
 *   - { kind: 'discard' } — file is account-level AND the obs has no
 *     tag (or tag matched nothing → and we DO open a phantom for that;
 *     "discard" only happens when there's literally no signal — no tag,
 *     no campaign folder)
 *
 * Tag (entity_campaign_name) takes precedence over folder attribution.
 * Same-bucket dedup happens at the caller via the bucket key.
 */
export function routeCampaignObs(
  obs: CampaignObservation,
  attribution: EntityAttribution,
  dir: CampaignNameDirectory | null,
): RouteCampaignObsResult {
  // (a) Tag-routed
  const emittedName = (obs.entity_campaign_name ?? '').trim();
  if (dir && emittedName) {
    const match = matchCampaignName(emittedName, dir.knownCampaignNames);
    if (match) {
      const norm = match.matched.trim().toLowerCase();
      const ex = dir.existingByName.get(norm);
      if (ex) {
        return {
          kind: 'matched',
          via: match.via === 'exact' ? 'tag-exact' : 'levenshtein',
          similarity: match.similarity,
          key: `existing:${ex.campaignId}`,
          bucket: {
            campaignName: ex.name,
            campaignFolderId: ex.folderId,
            campaignStatus: 'existing',
            matchedCampaignId: ex.campaignId,
            bucketSource: 'folder',
            observations: [],
            fileIds: new Set(),
          },
        };
      }
      const nw = dir.newFolderByName.get(norm);
      if (nw) {
        return {
          kind: 'matched',
          via: match.via === 'exact' ? 'tag-folder' : 'levenshtein',
          similarity: match.similarity,
          key: `new:${nw.folderId}`,
          bucket: {
            campaignName: nw.name,
            campaignFolderId: nw.folderId,
            campaignStatus: 'new',
            matchedCampaignId: null,
            bucketSource: 'folder',
            observations: [],
            fileIds: new Set(),
          },
        };
      }
      // (match found but neither map has it — shouldn't happen since
      // knownCampaignNames is the union, but fall through to phantom
      // defensively.)
    }
    // No name match → phantom new candidate
    const normEmitted = emittedName.toLowerCase();
    return {
      kind: 'phantom',
      via: 'phantom',
      similarity: 0,
      key: `phantom:${normEmitted}`,
      bucket: {
        campaignName: emittedName,
        campaignFolderId: null,
        campaignStatus: 'new',
        matchedCampaignId: null,
        bucketSource: 'phantom',
        observations: [],
        fileIds: new Set(),
      },
    };
  }

  // (b) No tag → fall back to folder attribution
  if (attribution.ownerType === 'campaign' && attribution.campaignFolderId) {
    if (attribution.campaignStatus === 'existing' && attribution.matchedCampaignId) {
      return {
        kind: 'matched',
        via: 'folder',
        similarity: 1,
        key: `existing:${attribution.matchedCampaignId}`,
        bucket: {
          campaignName: attribution.campaignName ?? '(unnamed campaign)',
          campaignFolderId: attribution.campaignFolderId,
          campaignStatus: 'existing',
          matchedCampaignId: attribution.matchedCampaignId,
          bucketSource: 'folder',
          observations: [],
          fileIds: new Set(),
        },
      };
    }
    return {
      kind: 'matched',
      via: 'folder',
      similarity: 1,
      key: `new:${attribution.campaignFolderId}`,
      bucket: {
        campaignName: attribution.campaignName ?? '(unnamed campaign)',
        campaignFolderId: attribution.campaignFolderId,
        campaignStatus: attribution.campaignStatus ?? 'new',
        matchedCampaignId: attribution.matchedCampaignId,
        bucketSource: 'folder',
        observations: [],
        fileIds: new Set(),
      },
    };
  }

  // (c) Account-level file with no tag → no owner
  return { kind: 'discard' };
}

/**
 * Drive returned 403 for a file's CONTENT while its metadata was listable —
 * the restricted-file condition (shortcut to an unshared personal-drive doc,
 * or download-restricted file), distinct from transient errors. These become
 * worklist rows re-probed every scan; see the drive_restricted_files model.
 *
 * Rate-limit 403s (userRateLimitExceeded etc.) are EXCLUDED: when the
 * limiter exhausts its retries that 403 is transient, not a permission
 * condition — classifying it as restricted minted a bogus worklist row
 * plus a false "content is access-restricted" dossier observation.
 */
export function isDrivePermissionError(err: unknown): boolean {
  if (isRateLimitError(err)) return false;
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number | string; response?: { status?: number } };
  return e.code === 403 || e.code === '403' || e.response?.status === 403;
}
