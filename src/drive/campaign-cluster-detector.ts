/**
 * campaign-cluster-detector.ts — Gemini-backed clustering for an account's
 * Campaign roster. Groups Campaign rows that refer to the SAME real-world
 * campaign — judged by campaign IDENTITY (the initiative each name points to),
 * NOT by name-string similarity. Two projects can be one campaign under
 * different deliverable names; two near-identical strings can be different
 * campaigns. Names-only by design — the humans naming campaigns carry the
 * accountability; the model's job is to UNDERSTAND the names, not to add data.
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
/**
 * MUST be generous: gemini-3.5-flash's THINKING tokens count against this cap.
 * A dense window can emit a dozen clusters; too low a cap gets eaten by
 * thinking and truncates the JSON mid-array → parse failure → the window
 * silently returns empty and merges are lost (4096 caused ~400 such failures
 * and a 5× under-merge). Speed comes from the lean names-only INPUT, not from
 * starving the output.
 */
const MAX_OUTPUT_TOKENS = 16384;

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
  // Names only. The orchestrator picks the canonical row in code
  // (folder-anchored > has markdown > oldest) and only consumes the GROUPING,
  // so the model never needs markdown/folder/date — feeding them just inflated
  // each call's latency (~20K chars/window). Keeping it lean is the speed win.
  const campaignsJson = JSON.stringify(
    args.campaigns.map((c) => ({ id: c.id, name: c.name })),
    null,
    2,
  );

  return `You are in charge of organizing an ad agency's data. I'm giving you an account (the client) and a list of titles of work done for that account, each with an id. These may be campaigns. They may be executions within a campaign. They may be something else entirely.

ACCOUNT: ${args.accountName}

TITLES (id, name):
${campaignsJson}

Use your best judgement to reduce the list to a clean, non-duplicate list of campaigns, against a few predictable scenarios:
- Executions of one campaign are often filed as separate campaigns. This is easiest to spot when non-standard language is reused across multiple titles — a slogan, or an acronym that is not attributable to a generic concept. Do NOT merge titles that only reuse generic or standard domain language (e.g. "chocolate" for a candy company).
- An acronym is sometimes a clear compression of another title's words — treat those as the same campaign, but only at high confidence.

For each set of titles that are the same campaign, return:
- canonicalId: the title that most clearly names the campaign
- canonicalName: that name, verbatim
- variantIds: the others in the set
- confidence: 0.0–1.0
- reasoning: one sentence

Only return sets of two or more, and only above ${CONFIDENCE_FLOOR} confidence. When unsure, leave titles separate.`;
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

// ── Deterministic round-robin clustering ────────────────────────────────────
//
// A single LLM call over a large roster (e.g. Chevy's 404 campaigns) is
// unreliable — the model can't exhaustively group hundreds of names in one
// shot (observed: 1 cluster one run, 20+ the next).
//
// Sorting variants adjacent is brittle (assumes duplicates share a prefix:
// "Red Tag" vs "Chevy Red Tag Holiday Event" never sort together). Random
// shuffles fix that but pay a coupon-collector penalty — to GUARANTEE every
// pair has shared a window you'd need ~(N/W)·ln(#pairs) rounds, ~15× the floor.
//
// So we cover deterministically, at the combinatorial floor. In one round an
// item shares its window with ≤ W−1 others, so full pairwise coverage needs
// ≥ (N−1)/(W−1) rounds — that bound is achievable with a round-robin:
//
//   1. Split the working list into BLOCKS of W/2. A window = two blocks (≤ W).
//   2. ROUND-ROBIN the blocks (circle method): over (B−1) rounds every pair of
//      blocks shares a window exactly once → every cross-block campaign pair
//      co-occurs once; same-block pairs co-occur every round (≥2×).
//   3. Run VOTE_THRESHOLD passes with different block assignments. Cross-block
//      pairs get 1 co-occurrence per pass → ≥ threshold overall; same-block get
//      more. So EVERY pair is examined ≥ threshold times, guaranteed.
//   4. UNION pairs the LLM co-grouped in ≥ threshold windows (guards against a
//      single spurious grouping chaining unrelated campaigns).
//   5. COLLAPSE to one canonical per merged component and repeat the schedule on
//      the shrunken list until a schedule finds no new merge (catches LLM
//      per-window misses + transitive joins). Round count recomputes from the
//      smaller B each schedule.

const WINDOW_SIZE = 40;
const VOTE_THRESHOLD = 2;
/**
 * Backstop on schedules. Each schedule = full pairwise coverage; schedule 1
 * catches ~95% of merges and schedules 3-4 found <5 each on the full roster,
 * so 2 is the sweet spot. The merge is idempotent — re-run to mop up the tail.
 */
const MAX_SCHEDULES = 2;
/** Concurrent window LLM calls. The dev Gemini key tolerates this fine. */
const WINDOW_CONCURRENCY = 10;

/** Deterministic PRNG (mulberry32) so block assignments are reproducible. */
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

/** Split into non-overlapping blocks of `size` (keeps a smaller final block). */
function intoBlocks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Round-robin (circle method) over B block indices. Returns (B−1 or B) rounds,
 * each a list of [blockA, blockB] index pairs. Every pair of block indices
 * appears together in exactly one round. A dummy "bye" (-1) is added when B is
 * odd and filtered from the output.
 */
function roundRobinPairings(B: number): Array<Array<[number, number]>> {
  const arr: number[] = [];
  for (let i = 0; i < B; i++) arr.push(i);
  if (arr.length % 2 === 1) arr.push(-1); // bye
  const n = arr.length;
  const rounds: Array<Array<[number, number]>> = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i]!;
      const b = arr[n - 1 - i]!;
      if (a !== -1 && b !== -1) pairs.push([a, b]);
    }
    rounds.push(pairs);
    // Rotate all but the first element clockwise.
    const last = arr[n - 1]!;
    for (let i = n - 1; i > 1; i--) arr[i] = arr[i - 1]!;
    arr[1] = last;
  }
  return rounds;
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
 * Build the full set of windows for one schedule: `voteThreshold` round-robin
 * passes over W/2-blocks, with a fast path when the whole list fits one window.
 * Guarantees every pair of the input campaigns is examined ≥ voteThreshold
 * times. Returns each window's campaign list.
 */
function buildScheduleWindows(
  working: CampaignForClustering[],
  windowSize: number,
  voteThreshold: number,
  scheduleSeed: number,
): CampaignForClustering[][] {
  const windows: CampaignForClustering[][] = [];
  if (working.length <= windowSize) {
    for (let p = 0; p < voteThreshold; p++) windows.push(working);
    return windows;
  }
  const blockSize = Math.max(1, Math.floor(windowSize / 2));
  for (let p = 0; p < voteThreshold; p++) {
    const blocks = intoBlocks(shuffled(working, scheduleSeed * 31 + p), blockSize);
    for (const round of roundRobinPairings(blocks.length)) {
      for (const [a, b] of round) {
        windows.push([...blocks[a]!, ...blocks[b]!]);
      }
    }
  }
  return windows;
}

/**
 * Detect duplicate clusters across a large roster via repeated deterministic
 * round-robin schedules (full pairwise coverage per schedule) with corroborated
 * union and a working list that shrinks as duplicates fold in. See the block
 * comment above.
 */
export async function detectCampaignClustersWindowed(args: {
  accountName: string;
  campaigns: CampaignForClustering[];
  windowSize?: number;
  voteThreshold?: number;
}): Promise<ClusterDetectionResult> {
  const windowSize = args.windowSize ?? WINDOW_SIZE;
  const voteThreshold = args.voteThreshold ?? VOTE_THRESHOLD;

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
  let schedule = 0;
  let windowCalls = 0;

  while (schedule < MAX_SCHEDULES && working.length >= 2) {
    schedule++;
    const windows = buildScheduleWindows(working, windowSize, voteThreshold, schedule);

    const results = await mapPool(windows, WINDOW_CONCURRENCY, async (window) => {
      windowCalls++;
      try {
        return await detectCampaignClusters({ accountName: args.accountName, campaigns: window });
      } catch (err) {
        logger.warn({ err, schedule }, '[cluster-detector] window detection failed — skipped');
        return { clusters: [], droppedClusterCount: 0 } as ClusterDetectionResult;
      }
    });

    // Tally pair co-occurrences from this schedule's window groupings.
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

    logger.info(
      { schedule, windows: windows.length, working: working.length, newMerges, windowCalls },
      '[cluster-detector] schedule complete',
    );
    if (newMerges === 0) break;
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
      reasoning: `${compReason.get(root) ?? 'duplicate group'} [round-robin: ${members.length} campaigns, corroborated ×${voteThreshold}]`,
    });
  }

  logger.info(
    {
      totalCampaigns: args.campaigns.length,
      schedules: schedule,
      windowCalls,
      voteThreshold,
      clustersFound: clusters.length,
    },
    '[cluster-detector] round-robin clustering complete',
  );

  return { clusters, droppedClusterCount: 0 };
}
