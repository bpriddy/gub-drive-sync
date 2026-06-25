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

// ── Randomized-round clustering ─────────────────────────────────────────────
//
// A single LLM call over a large roster (e.g. Chevy's 404 campaigns) is
// unreliable — the model can't exhaustively group hundreds of names in one
// shot (observed: 1 cluster one run, 20+ the next).
//
// Sorting variants adjacent (an earlier approach) is brittle: it assumes
// duplicates share a prefix. "Red Tag" vs "Chevy Red Tag Holiday Event" never
// sort together. So instead we RANDOMIZE:
//
//   1. SCRAMBLE the working list (seeded shuffle → reproducible).
//   2. CHUNK into non-overlapping windows; each is a small, focused single-shot
//      clustering call (≤ WINDOW_SIZE names), run concurrently.
//   3. VOTE: tally how many windows co-group each pair across rounds. Union a
//      pair once it reaches VOTE_THRESHOLD corroborating co-occurrences — this
//      guards against one spurious LLM grouping transitively chaining unrelated
//      campaigns.
//   4. COLLAPSE: after each round, reduce the working list to one representative
//      (the code-chosen canonical) per merged component. The list shrinks as
//      duplicates fold in.
//   5. RECOMPUTE the target round count from the shrunken list size, and stop
//      once we've done enough rounds AND recent rounds found nothing new.
//
// Over enough random rounds, ANY pair eventually shares a window regardless of
// spelling — no prefix assumption. As the list shrinks below WINDOW_SIZE every
// remaining campaign is compared every round, so the tail is fully covered.

const WINDOW_SIZE = 40;
const VOTE_THRESHOLD = 2;
/** Target rounds = ceil(COVERAGE * N / WINDOW_SIZE); ≈ expected co-occurrences per pair. */
const COVERAGE = 4;
/** Stop once round count is satisfied AND this many consecutive rounds found no new merge. */
const DRY_STOP = 2;
/** Absolute backstop on rounds regardless of convergence. */
const HARD_ROUND_CAP = 80;
/** Concurrent window LLM calls within a round. */
const WINDOW_CONCURRENCY = 6;

/** Deterministic PRNG (mulberry32) so scrambles are reproducible per run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded Fisher-Yates shuffle (returns a new array). */
function shuffled<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  const rand = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Split into non-overlapping chunks of `size` (last chunk may be smaller). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    const c = arr.slice(i, i + size);
    if (c.length >= 2) out.push(c);
  }
  return out;
}

/** Bounded-concurrency map. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
 * Detect duplicate clusters across a large roster via randomized rounds of
 * windowed single-shot clustering, with corroborated union and a working list
 * that shrinks as duplicates fold in. See the block comment above.
 */
export async function detectCampaignClustersWindowed(args: {
  accountName: string;
  campaigns: CampaignForClustering[];
  windowSize?: number;
  voteThreshold?: number;
  coverage?: number;
}): Promise<ClusterDetectionResult> {
  const windowSize = args.windowSize ?? WINDOW_SIZE;
  const voteThreshold = args.voteThreshold ?? VOTE_THRESHOLD;
  const coverage = args.coverage ?? COVERAGE;

  if (args.campaigns.length < 2) return { clusters: [], droppedClusterCount: 0 };

  // pairKey "idA|idB" (sorted) → vote count + best contributing group's conf/reason.
  const pairTally = new Map<string, { count: number; conf: number; reason: string }>();

  // Union-find over campaign ids (path compression).
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
  const union = (a: string, b: string): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent.set(ra, rb);
    return true;
  };

  // working = current representatives (canonical per merged component).
  let working = [...args.campaigns];
  let round = 0;
  let dryStreak = 0;
  let windowCalls = 0;

  while (round < HARD_ROUND_CAP && working.length >= 2) {
    round++;
    const order = shuffled(working, round * 0x9e3779b1);
    const windows = chunk(order, windowSize);

    const results = await mapPool(windows, WINDOW_CONCURRENCY, async (window) => {
      windowCalls++;
      try {
        return await detectCampaignClusters({ accountName: args.accountName, campaigns: window });
      } catch (err) {
        logger.warn({ err, round }, '[cluster-detector] window detection failed — skipped');
        return { clusters: [], droppedClusterCount: 0 } as ClusterDetectionResult;
      }
    });

    // Tally pair co-occurrences from this round's window groupings.
    for (const res of results) {
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

    // Promote corroborated pairs to merges.
    let newMerges = 0;
    for (const [key, v] of pairTally) {
      if (v.count >= voteThreshold) {
        const [a, b] = key.split('|') as [string, string];
        if (union(a, b)) newMerges++;
      }
    }

    // Collapse the working list to one representative per component.
    const groups = new Map<string, CampaignForClustering[]>();
    for (const c of working) {
      const r = find(c.id);
      const g = groups.get(r) ?? [];
      g.push(c);
      groups.set(r, g);
    }
    working = [...groups.values()].map((members) => pickCanonical(members));

    dryStreak = newMerges > 0 ? 0 : dryStreak + 1;
    const targetRounds = Math.ceil((coverage * working.length) / windowSize);
    logger.info(
      { round, working: working.length, newMerges, targetRounds, dryStreak },
      '[cluster-detector] round complete',
    );
    if (round >= targetRounds && dryStreak >= DRY_STOP) break;
  }

  // Build final clusters from union-find over ALL original ids.
  const compMembers = new Map<string, CampaignForClustering[]>();
  for (const c of args.campaigns) {
    const r = find(c.id);
    const g = compMembers.get(r) ?? [];
    g.push(c);
    compMembers.set(r, g);
  }
  // Per component, the best conf/reason among its corroborated pairs.
  const compConf = new Map<string, number>();
  const compReason = new Map<string, string>();
  for (const [key, v] of pairTally) {
    if (v.count < voteThreshold) continue;
    const [a] = key.split('|') as [string, string];
    const root = find(a);
    if ((compConf.get(root) ?? 0) < v.conf) {
      compConf.set(root, v.conf);
      compReason.set(root, v.reason);
    }
  }

  const clusters: DetectedCluster[] = [];
  for (const [root, members] of compMembers) {
    if (members.length < 2) continue;
    const canonical = pickCanonical(members);
    const variants = members.filter((m) => m.id !== canonical.id);
    clusters.push({
      canonicalId: canonical.id,
      canonicalName: canonical.name,
      variantIds: variants.map((v) => v.id),
      variantNames: variants.map((v) => v.name),
      confidence: compConf.get(root) ?? CONFIDENCE_FLOOR,
      reasoning: `${compReason.get(root) ?? 'duplicate group'} [randomized rounds: ${members.length} campaigns, corroborated ×${voteThreshold}]`,
    });
  }

  logger.info(
    {
      totalCampaigns: args.campaigns.length,
      rounds: round,
      windowCalls,
      voteThreshold,
      coverage,
      clustersFound: clusters.length,
    },
    '[cluster-detector] randomized-round clustering complete',
  );

  return { clusters, droppedClusterCount: 0 };
}
