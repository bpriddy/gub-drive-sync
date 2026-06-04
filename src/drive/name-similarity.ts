/**
 * name-similarity.ts — fuzzy-match a per-file LLM's emitted
 * entity_campaign_name against the known campaign vocabulary.
 *
 * Two-tier matching, deliberately conservative (we'd rather open a new
 * candidate that needs manual merge later than silently collapse two
 * distinct campaigns into one):
 *
 *   1. EXACT (case-insensitive, trimmed) → known name verbatim
 *   2. LEVENSHTEIN RATIO >= 0.85 → known name verbatim (typo / whitespace
 *      / punctuation tolerance)
 *
 * No token-subset rule: "Fall Equinox" vs "Fall Equinox 2024" are
 * scope-distinct (general vs year-specific) and should NOT silently
 * merge. The 0.85 ratio threshold is tight enough to keep them apart
 * (ratio ≈ 0.71 between those two) while accepting normal typos
 * (e.g., "Fall Equnox" → "Fall Equinox" at ratio ≈ 0.92).
 *
 * Returns null when nothing crosses the threshold → orchestrator opens
 * a phantom-name bucket (becomes a folder-less new-candidate Campaign
 * on persist).
 */

export interface NameMatch {
  /** Verbatim from the knownCampaigns input (preserves canonical casing). */
  matched: string;
  via: 'exact' | 'levenshtein';
  /** Levenshtein ratio for inspection / logging. 1.0 for exact. */
  similarity: number;
}

/**
 * Normalize for comparison: lowercase + trim + collapse whitespace.
 * Does NOT strip punctuation — "Coach 'Em Up :30" vs "Coach Em Up :30"
 * is exactly the kind of distinction Levenshtein can score (small diff,
 * still passes 0.85).
 */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev, dp[j]!, dp[j - 1]!) + 1;
      }
      prev = tmp;
    }
  }
  return dp[n]!;
}

/** Normalized similarity in [0, 1]. 1 = identical, 0 = no overlap. */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

const MIN_RATIO = 0.85;

/**
 * Match an LLM-emitted campaign name against a list of known names.
 * Returns the canonical (verbatim) known name on match, or null.
 *
 * On multiple candidates above threshold, returns the highest-scoring
 * match (ties broken by list order).
 */
export function matchCampaignName(
  emitted: string,
  knownCampaigns: string[],
): NameMatch | null {
  const emittedNorm = normalize(emitted);
  if (!emittedNorm) return null;

  // 1. Exact match (case-insensitive, whitespace-normalized).
  for (const known of knownCampaigns) {
    if (normalize(known) === emittedNorm) {
      return { matched: known, via: 'exact', similarity: 1 };
    }
  }

  // 2. Levenshtein ratio above threshold.
  let best: NameMatch | null = null;
  for (const known of knownCampaigns) {
    const sim = similarity(emittedNorm, normalize(known));
    if (sim >= MIN_RATIO && (!best || sim > best.similarity)) {
      best = { matched: known, via: 'levenshtein', similarity: sim };
    }
  }
  return best;
}
