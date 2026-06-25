/**
 * campaign-cluster-detector.ts — Gemini-backed clustering for an account's
 * Campaign roster. Identifies duplicate Campaign rows that represent the SAME
 * real-world campaign (year-drift variants, suffix noise, separator drift,
 * surface punctuation, date qualifiers).
 *
 * Output is a merge proposal: per cluster, a canonical id to KEEP and a list
 * of variant ids that should be merged into the canonical and deleted.
 *
 * Bias: split-by-default. The prompt instructs the model to omit any cluster
 * with confidence < 0.8 — better to leave a duplicate than to merge two
 * distinct campaigns.
 *
 * Used by the merge-campaign-dupes Cloud Run Job mode (src/drive/campaign-merge.ts):
 * a dry-run logs the proposed clusters; --confirm applies them.
 */

import { z } from 'zod';
import { SchemaType, type ResponseSchema } from '@google/generative-ai';
import { defaultLlm } from '../ai';
import { parseLlmJson } from '../ai/prompt-preset.service';
import { logger } from '../logger';

const MODEL = 'gemini-3.5-flash';
const CONFIDENCE_FLOOR = 0.8;
const MARKDOWN_EXCERPT_CHARS = 500;
/**
 * The clustering response scales with the number of duplicate clusters in
 * the account. A big roster (e.g. Chevy) can emit dozens of clusters; the
 * model's default output cap truncates the JSON mid-string and fails the
 * parse. Set generously — structured output keeps it from rambling.
 */
const MAX_OUTPUT_TOKENS = 32768;

export interface CampaignForClustering {
  id: string;
  name: string;
  status: string;
  driveFolderId: string | null;
  statusMarkdown: string | null;
  createdAt: Date;
}

export interface DetectedCluster {
  canonicalId: string;
  canonicalName: string;
  variantIds: string[];
  variantNames: string[];
  confidence: number;
  reasoning: string;
}

export interface ClusterDetectionResult {
  clusters: DetectedCluster[];
  /** IDs the LLM proposed but that were dropped during validation. */
  droppedClusterCount: number;
}

const ResponseSchemaZ = z.object({
  clusters: z
    .array(
      z.object({
        canonicalId: z.string(),
        canonicalName: z.string().min(1),
        variantIds: z.array(z.string()).min(1),
        confidence: z.number().min(0).max(1),
        reasoning: z.string().min(1),
      }),
    )
    .default([]),
});

const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    clusters: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          canonicalId: { type: SchemaType.STRING },
          canonicalName: { type: SchemaType.STRING },
          variantIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          confidence: { type: SchemaType.NUMBER },
          reasoning: { type: SchemaType.STRING },
        },
        required: ['canonicalId', 'canonicalName', 'variantIds', 'confidence', 'reasoning'],
      },
    },
  },
  required: ['clusters'],
};

function buildPrompt(args: {
  accountName: string;
  campaigns: CampaignForClustering[];
}): string {
  const campaignsJson = JSON.stringify(
    args.campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      folder_anchored: c.driveFolderId !== null,
      markdown_excerpt:
        c.statusMarkdown && c.statusMarkdown.length > 0
          ? c.statusMarkdown.slice(0, MARKDOWN_EXCERPT_CHARS)
          : null,
      created_at: c.createdAt.toISOString().slice(0, 10),
    })),
    null,
    2,
  );

  return `You are reviewing the campaign roster for an agency account. The roster may contain duplicate rows that were created during automated content extraction — surface variations of the same campaign name (year drift, suffix noise, separator drift, surface punctuation) were each treated as a distinct campaign.

ACCOUNT: ${args.accountName}

CAMPAIGNS (id, name, status, folder_anchored, markdown_excerpt, created_at):
${campaignsJson}

TASK
Group campaigns that represent the SAME real-world campaign. For each cluster of duplicates, return:
- canonicalId: the id of the campaign to KEEP (others get merged into it and deleted)
- canonicalName: the canonical name, verbatim from one of the input "name" fields
- variantIds: ids of campaigns that should be merged INTO the canonical
- confidence: 0.0–1.0 — how sure you are these are the same campaign
- reasoning: one sentence explaining the grouping

WHAT COUNTS AS A DUPLICATE (collapse these)
- Year variants: "Truck Season" / "Truck Season 2025" / "Truck Season '25"
- Suffix noise: "Truck Season" / "Truck Season Campaign"
- Separator drift: "Army/Navy" / "Army Navy"
- Surface punctuation / casing: "ARMY NAVY GAME" / "Army Navy Game"
- Date qualifiers for the same event: "Army Navy Game" / "Army/Navy (Dec 14th)"

WHAT IS NOT A DUPLICATE (keep distinct)
- Campaigns that share a theme but are different programs: "Truck Day" (one-day promo) vs "Truck Season" (Q4 retail push) are distinct.
- Different annual editions: "Holiday 2023" vs "Holiday 2024" — both real, both kept.
- Brief vs Pitch concept ideas vs final campaign — keep distinct unless the names truly converge.

Use real-world knowledge: Army-Navy is the annual college football game in December; a "truck season" is the auto-industry's Q4 retail push; "Heartbeat of America" is a Chevy slogan from 1986 (not a live campaign).

CANONICAL SELECTION inside a cluster (priority order)
1. Prefer the campaign with folder_anchored=true (real Drive folder backing it).
2. Among folder-less rows, prefer the one with a non-empty markdown_excerpt.
3. Tie-break by most recent created_at.

CANONICAL NAME (within priority)
- Verbatim from one of the input names.
- Prefer the variant that INCLUDES the year if one is present.
- Prefer the form WITHOUT a trailing "Campaign" noise word.

HARD RULES
- Every id in your output must appear in the INPUT campaigns. No invented ids.
- No id may appear in more than one cluster (canonical or variant).
- A canonicalId must NOT also appear in its own variantIds.
- OMIT any cluster where your confidence < ${CONFIDENCE_FLOOR}. Better to leave a duplicate than to wrongly merge two distinct campaigns.
- OMIT any cluster of size 1 (a campaign alone is not a duplicate).
- Standalone campaigns (no duplicates found): just omit them entirely from the output.`;
}

function validateClusters(
  resp: z.infer<typeof ResponseSchemaZ>,
  campaigns: CampaignForClustering[],
): ClusterDetectionResult {
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const clean: DetectedCluster[] = [];
  let dropped = 0;

  for (const cluster of resp.clusters) {
    const canonical = byId.get(cluster.canonicalId);
    if (!canonical) {
      logger.warn(
        { canonicalId: cluster.canonicalId },
        '[cluster-detector] canonicalId not in input — dropped',
      );
      dropped++;
      continue;
    }

    // Filter variantIds: must exist in input AND not equal canonical.
    const variantIds = cluster.variantIds.filter(
      (id) => byId.has(id) && id !== cluster.canonicalId,
    );
    if (variantIds.length === 0) {
      dropped++;
      continue;
    }

    // Reject if any id already claimed by an earlier cluster.
    const conflict = [cluster.canonicalId, ...variantIds].some((id) => seen.has(id));
    if (conflict) {
      logger.warn(
        { canonicalId: cluster.canonicalId, variantIds },
        '[cluster-detector] cluster overlaps prior cluster — dropped',
      );
      dropped++;
      continue;
    }

    // Reject if confidence below floor (defense; prompt already says so).
    if (cluster.confidence < CONFIDENCE_FLOOR) {
      dropped++;
      continue;
    }

    seen.add(cluster.canonicalId);
    variantIds.forEach((id) => seen.add(id));

    clean.push({
      canonicalId: cluster.canonicalId,
      canonicalName: cluster.canonicalName,
      variantIds,
      variantNames: variantIds.map((id) => byId.get(id)!.name),
      confidence: cluster.confidence,
      reasoning: cluster.reasoning,
    });
  }

  return { clusters: clean, droppedClusterCount: dropped };
}

/**
 * Detect duplicate clusters within an account's campaign roster.
 *
 * Returns an empty result when the input has fewer than 2 campaigns (nothing
 * to cluster).
 */
export async function detectCampaignClusters(args: {
  accountName: string;
  campaigns: CampaignForClustering[];
}): Promise<ClusterDetectionResult> {
  if (args.campaigns.length < 2) {
    return { clusters: [], droppedClusterCount: 0 };
  }

  const prompt = buildPrompt(args);
  const completion = await defaultLlm.complete({
    model: MODEL,
    temperature: 0,
    prompt,
    tag: 'campaign_cluster_detection.v1',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  let parsed: z.infer<typeof ResponseSchemaZ>;
  try {
    const raw = parseLlmJson(completion.text);
    parsed = ResponseSchemaZ.parse(raw);
  } catch (err) {
    logger.error(
      { err, raw: completion.text.slice(0, 1000) },
      '[cluster-detector] response parse failed',
    );
    throw new Error('Campaign cluster detector: LLM response failed schema validation');
  }

  return validateClusters(parsed, args.campaigns);
}

// ── Windowed clustering ─────────────────────────────────────────────────────
//
// A single LLM call over a large roster (e.g. Chevy's 404 campaigns) is
// unreliable — the model can't hold and exhaustively group hundreds of names
// in one shot (observed: 1 cluster one run, 20+ the next). Treat it as a
// sorting problem instead:
//
//   1. SORT campaigns by a normalized key so variants land adjacent.
//   2. SLIDE an overlapping window across the sorted list; each window is a
//      small, focused single-shot clustering call (≤ WINDOW_SIZE names).
//   3. REPEAT with a second sort key (token-sorted) so word-order variants
//      also become adjacent.
//   4. UNION pairs that were co-grouped in ≥ VOTE_THRESHOLD windows. The vote
//      threshold guards against one spurious LLM grouping transitively
//      chaining unrelated campaigns through union-find.
//
// Canonical selection happens deterministically in code (folder-anchored >
// has markdown > oldest), so per-window canonical disagreement doesn't matter.

const WINDOW_SIZE = 40;
const WINDOW_STEP = 20; // 50% overlap → interior pairs appear in ~2 windows/pass
const PASSES = 2;
const VOTE_THRESHOLD = 2;

/** Brand prefix + all non-alphanumeric stripped — variants sort adjacent. */
function alnumKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*(chevrolet|chevy)\s*[|:–-]\s*/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Tokens sorted alphabetically — word-order variants collide. */
function tokenSortedKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*(chevrolet|chevy)\s*[|:–-]\s*/i, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join('');
}

function windowsOf<T>(arr: T[], size: number, step: number): T[][] {
  if (arr.length < 2) return [];
  if (arr.length <= size) return [arr];
  const out: T[][] = [];
  for (let start = 0; start < arr.length; start += step) {
    const w = arr.slice(start, start + size);
    if (w.length >= 2) out.push(w);
    if (start + size >= arr.length) break;
  }
  return out;
}

/** Canonical = folder-anchored > non-empty markdown > oldest createdAt. */
function pickCanonical(members: CampaignForClustering[]): CampaignForClustering {
  return [...members].sort((a, b) => {
    const fa = a.driveFolderId ? 1 : 0;
    const fb = b.driveFolderId ? 1 : 0;
    if (fa !== fb) return fb - fa;
    const ma = a.statusMarkdown ? 1 : 0;
    const mb = b.statusMarkdown ? 1 : 0;
    if (ma !== mb) return mb - ma;
    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0]!;
}

/**
 * Detect duplicate clusters across a large roster via sorted sliding windows
 * + corroborated union. See the block comment above for the algorithm.
 */
export async function detectCampaignClustersWindowed(args: {
  accountName: string;
  campaigns: CampaignForClustering[];
  windowSize?: number;
  windowStep?: number;
  passes?: number;
  voteThreshold?: number;
}): Promise<ClusterDetectionResult> {
  const windowSize = args.windowSize ?? WINDOW_SIZE;
  const windowStep = args.windowStep ?? WINDOW_STEP;
  const passes = args.passes ?? PASSES;
  const voteThreshold = args.voteThreshold ?? VOTE_THRESHOLD;

  if (args.campaigns.length < 2) return { clusters: [], droppedClusterCount: 0 };

  const byId = new Map(args.campaigns.map((c) => [c.id, c]));
  // pairKey "idA|idB" (sorted) → vote count + best contributing group's conf/reason.
  const pairTally = new Map<string, { count: number; conf: number; reason: string }>();

  const sortKeys: Array<(c: CampaignForClustering) => string> = [
    (c) => alnumKey(c.name),
    (c) => tokenSortedKey(c.name),
  ];

  let windowCalls = 0;
  for (let pass = 0; pass < passes; pass++) {
    const keyFn = sortKeys[pass % sortKeys.length]!;
    const sorted = [...args.campaigns].sort((a, b) => {
      const ka = keyFn(a);
      const kb = keyFn(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a.id.localeCompare(b.id);
    });
    for (const window of windowsOf(sorted, windowSize, windowStep)) {
      windowCalls++;
      let res: ClusterDetectionResult;
      try {
        res = await detectCampaignClusters({ accountName: args.accountName, campaigns: window });
      } catch (err) {
        logger.warn({ err, pass }, '[cluster-detector] window detection failed — skipped');
        continue;
      }
      for (const cl of res.clusters) {
        const ids = [cl.canonicalId, ...cl.variantIds];
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const key = [ids[i]!, ids[j]!].sort().join('|');
            const prev = pairTally.get(key);
            if (prev) {
              prev.count++;
              if (cl.confidence > prev.conf) {
                prev.conf = cl.confidence;
                prev.reason = cl.reasoning;
              }
            } else {
              pairTally.set(key, { count: 1, conf: cl.confidence, reason: cl.reasoning });
            }
          }
        }
      }
    }
  }

  // Union pairs meeting the vote threshold (union-find with path compression).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const survivingPairs: Array<{ a: string; b: string; conf: number; reason: string }> = [];
  for (const [key, v] of pairTally) {
    if (v.count >= voteThreshold) {
      const [a, b] = key.split('|') as [string, string];
      union(a, b);
      survivingPairs.push({ a, b, conf: v.conf, reason: v.reason });
    }
  }

  // Group surviving members by component root; track best conf/reason per root.
  const compMembers = new Map<string, Set<string>>();
  const compConf = new Map<string, number>();
  const compReason = new Map<string, string>();
  for (const p of survivingPairs) {
    const root = find(p.a);
    const set = compMembers.get(root) ?? new Set<string>();
    set.add(p.a);
    set.add(p.b);
    compMembers.set(root, set);
    if ((compConf.get(root) ?? 0) < p.conf) {
      compConf.set(root, p.conf);
      compReason.set(root, p.reason);
    }
  }

  const clusters: DetectedCluster[] = [];
  for (const [root, memberIds] of compMembers) {
    const members = [...memberIds].map((id) => byId.get(id)).filter((c): c is CampaignForClustering => !!c);
    if (members.length < 2) continue;
    const canonical = pickCanonical(members);
    const variants = members.filter((m) => m.id !== canonical.id);
    clusters.push({
      canonicalId: canonical.id,
      canonicalName: canonical.name,
      variantIds: variants.map((v) => v.id),
      variantNames: variants.map((v) => v.name),
      confidence: compConf.get(root) ?? CONFIDENCE_FLOOR,
      reasoning: `${compReason.get(root) ?? 'duplicate group'} [sliding-window: ${members.length} campaigns, corroborated]`,
    });
  }

  logger.info(
    {
      totalCampaigns: args.campaigns.length,
      windowCalls,
      passes,
      voteThreshold,
      clustersFound: clusters.length,
    },
    '[cluster-detector] windowed clustering complete',
  );

  return { clusters, droppedClusterCount: 0 };
}
