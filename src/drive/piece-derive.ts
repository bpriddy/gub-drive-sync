/**
 * piece-derive.ts — pieces the PRIMARY way: identified executions.
 *
 * A piece is an execution of a campaign — a thing the campaign actually
 * produced or is producing. Merge-born pieces (variant folders) are the
 * SECONDARY source: an execution that happened to be filed as its own job
 * folder. The primary source is the campaign's own content: its synthesized
 * dossier plainly declares what the campaign comprises (a film series, an AI
 * tool, a merch line), whether or not any folder maps to it.
 *
 * This module reads one campaign's dossier + its already-known pieces and
 * asks: what executions does this campaign comprise, and which are already
 * on file? Identification and matching happen in ONE call (index-based, like
 * the idea matcher — a model can't mangle an integer). New executions become
 * folder-less campaign_piece rows with markdown seeded from the identifying
 * content; matched ones are confirmed, not duplicated — so content-born and
 * folder-born pieces reconcile through one identity.
 *
 * Runs as a PASS (like merge-campaign-dupes): after scans have built the
 * campaign dossier. Re-runnable — known pieces are always in the candidate
 * list, so re-identification matches instead of duplicating (the ratchet).
 * Enrichment of folder-less pieces via subject routing (entity_piece_name)
 * is the follow-on; at birth their markdown is the identifying bullets.
 */

import { z } from 'zod';
import { SchemaType, type ResponseSchema } from '../ai';
import { prisma } from '../prisma';
import { defaultLlm, parseLlmJson } from '../ai';
import { logger } from '../logger';
import { assembleStatusMarkdown } from './status-synthesis';

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;
// gemini-3.5-flash thinking tokens count against this cap — keep generous.
const MAX_OUTPUT_TOKENS = 16384;
/** Executions below this confidence are reported but not created. */
const CONFIDENCE_FLOOR = 0.8;

export interface DerivedExecution {
  name: string;
  matchIndex: number;
  summaryBullets: string[];
  confidence: number;
}

export interface DerivePiecesResult {
  campaignId: string;
  campaignName: string;
  apply: boolean;
  identified: number;
  matchedExisting: number;
  created: number;
  belowFloor: number;
  executions: Array<DerivedExecution & { outcome: 'matched' | 'created' | 'would-create' | 'below-floor' }>;
  /** Null when the campaign has no dossier to read yet. */
  skippedNoDossier: boolean;
}

const ResponseSchemaZ = z.object({
  executions: z
    .array(
      z.object({
        name: z.string().min(1),
        match_index: z.number().int().min(0),
        summary_bullets: z.array(z.string()).default([]),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
});

const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    executions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING },
          match_index: { type: SchemaType.INTEGER },
          summary_bullets: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          confidence: { type: SchemaType.NUMBER },
        },
        required: ['name', 'match_index', 'summary_bullets', 'confidence'],
      },
    },
  },
  required: ['executions'],
};

function buildPrompt(args: {
  accountName: string;
  campaignName: string;
  dossier: string;
  knownPieces: Array<{ name: string }>;
}): string {
  const known =
    args.knownPieces.length > 0
      ? args.knownPieces.map((p, i) => `[${i + 1}] ${p.name}`).join('\n')
      : '(none yet)';

  return `You are organizing an ad agency's campaign records. Below is one campaign's dossier — everything the agency's files have revealed about it — plus the executions already on file for this campaign.

ACCOUNT: ${args.accountName}
CAMPAIGN: ${args.campaignName}

EXECUTIONS ALREADY ON FILE:
${known}

CAMPAIGN DOSSIER:
"""
${args.dossier}
"""

An EXECUTION is a distinct thing this campaign actually produced or is producing: a commercial or film series, a web tool or interactive experience, a merch or collectible line, an event or activation, a content series. It is NOT a discipline or workstream (strategy, media planning, finance, the production process itself), and NOT an idea that was pitched but never produced.

List the executions this campaign comprises, according to the dossier:
- name: what the work is called (short; use the dossier's own naming when it has one)
- match_index: the [n] of the on-file execution this IS, or 0 if it's not on file yet
- summary_bullets: 2-6 rows describing the execution, drawn from the dossier
- confidence: 0.0–1.0 that this is a real, distinct execution of this campaign

Only include executions the dossier clearly supports — precision over recall. When unsure whether something was actually produced or merely proposed, leave it out.`;
}

export async function deriveCampaignPieces(args: {
  campaignId: string;
  apply: boolean;
}): Promise<DerivePiecesResult> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: args.campaignId },
    select: {
      id: true,
      name: true,
      statusMarkdown: true,
      account: { select: { name: true } },
      pieces: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' } },
    },
  });

  const base: DerivePiecesResult = {
    campaignId: campaign.id,
    campaignName: campaign.name,
    apply: args.apply,
    identified: 0,
    matchedExisting: 0,
    created: 0,
    belowFloor: 0,
    executions: [],
    skippedNoDossier: false,
  };

  if (!campaign.statusMarkdown) {
    logger.info(
      { campaignId: campaign.id, campaignName: campaign.name },
      '[drive.piece-derive] no dossier yet — skipped',
    );
    return { ...base, skippedNoDossier: true };
  }

  const completion = await defaultLlm.complete({
    model: MODEL,
    temperature: TEMPERATURE,
    prompt: buildPrompt({
      accountName: campaign.account.name,
      campaignName: campaign.name,
      dossier: campaign.statusMarkdown,
      knownPieces: campaign.pieces,
    }),
    tag: 'drive.piece_derive.v1',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  let parsed: z.infer<typeof ResponseSchemaZ>;
  try {
    parsed = ResponseSchemaZ.parse(parseLlmJson<unknown>(completion.text));
  } catch (err) {
    logger.error({ err, raw: completion.text.slice(0, 400) }, '[drive.piece-derive] parse failed');
    throw err;
  }

  const today = new Date().toISOString().slice(0, 10);

  for (const ex of parsed.executions) {
    const name = ex.name.trim();
    const bullets = ex.summary_bullets.map((b) => b.trim()).filter(Boolean);
    const entry: DerivedExecution = {
      name,
      matchIndex: ex.match_index,
      summaryBullets: bullets,
      confidence: ex.confidence,
    };
    base.identified += 1;

    // Matched to an on-file piece (index guarded like the idea matcher) —
    // confirmed, never duplicated. Content-born meets folder-born here.
    if (ex.match_index > 0 && ex.match_index <= campaign.pieces.length) {
      base.matchedExisting += 1;
      base.executions.push({ ...entry, outcome: 'matched' });
      continue;
    }

    if (ex.confidence < CONFIDENCE_FLOOR) {
      base.belowFloor += 1;
      base.executions.push({ ...entry, outcome: 'below-floor' });
      continue;
    }

    // Belt-and-braces name idempotency (folder-less pieces have no unique
    // folder key): an existing same-named piece means match, not create.
    const collision = campaign.pieces.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (collision) {
      base.matchedExisting += 1;
      base.executions.push({ ...entry, outcome: 'matched' });
      continue;
    }

    if (!args.apply) {
      base.created += 1;
      base.executions.push({ ...entry, outcome: 'would-create' });
      continue;
    }

    // Birth: folder-less piece, markdown seeded from the identifying content.
    // Enrichment comes later via subject routing; this is the starting state.
    const seededMarkdown = assembleStatusMarkdown({
      editedAt: today,
      bullets: `- Name: ${name}\n- Campaign: ${campaign.name}`,
      contextProse: bullets.map((b) => `- ${b}`).join('\n'),
    });
    const created = await prisma.campaignPiece.create({
      data: {
        campaignId: campaign.id,
        name,
        statusMarkdown: seededMarkdown,
      },
    });
    campaign.pieces.push({ id: created.id, name }); // later executions match against it
    base.created += 1;
    base.executions.push({ ...entry, outcome: 'created' });
    logger.info(
      { campaignId: campaign.id, pieceId: created.id, name },
      '[drive.piece-derive] execution minted as piece (content-born, folder-less)',
    );
  }

  return base;
}

/** Derive pieces for every campaign of an account (each its own LLM call). */
export async function derivePiecesForAccount(args: {
  accountId: string;
  apply: boolean;
}): Promise<DerivePiecesResult[]> {
  const campaigns = await prisma.campaign.findMany({
    where: { accountId: args.accountId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const results: DerivePiecesResult[] = [];
  for (const c of campaigns) {
    try {
      results.push(await deriveCampaignPieces({ campaignId: c.id, apply: args.apply }));
    } catch (err) {
      logger.error({ err, campaignId: c.id }, '[drive.piece-derive] campaign failed — continuing');
    }
  }
  return results;
}
