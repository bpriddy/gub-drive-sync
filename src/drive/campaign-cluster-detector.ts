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
