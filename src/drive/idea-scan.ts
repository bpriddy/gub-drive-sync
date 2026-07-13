/**
 * idea-scan.ts — ideas wired into the REAL scan (the production path).
 *
 * The per-file extractor (interpret.ts) classifies every file's deck_type as
 * a byproduct of the read it already does. When a file is a pitch or
 * creative-review deck, the orchestrator calls processFileIdeas: the focused
 * idea extraction (which re-verifies the gate itself — the two calls agree by
 * design), then the account-scoped match+merge (add new facets, supersede
 * refined ones), then persistence (idea + idea_changes) — the same
 * add-and-overwrite semantics the extract-ideas harness validated on BHAC.
 *
 * A context object carries the per-scan known-ideas cache: loaded lazily on
 * the first deck, then advanced in memory as ideas are created/merged, so
 * multiple decks in one scan collapse against each other, not just against
 * the DB. Because this runs inside the scan, it inherits the scan's delta
 * gating — an unchanged deck is never reprocessed, which is what keeps the
 * (stochastic-reword) change-log churn bounded in forward operation.
 *
 * Failure discipline: idea work must never fail the FILE — the observation
 * pipeline is the primary product. Every error is counted and swallowed.
 */

import { prisma } from '../prisma';
import { logger } from '../logger';
import { extractIdeasFromFile } from './idea-extraction';
import { matchAndMergeIdea, type KnownIdea } from './idea-matcher';
import { facetsEqual, renderFacets } from './idea-runner';
import { DRIVE_SYNC_SYSTEM_STAFF_ID } from './heal';
import type { PerFileDeckType } from './interpret';
import type { TraversedFile } from './types';

export interface IdeaScanStats {
  /** Files classified pitch/creative_review that reached idea extraction. */
  deckFiles: number;
  ideasCreated: number;
  ideasUpdated: number;
  /** Merges that re-stated an idea with nothing new (no write). */
  ideasUnchanged: number;
  /** Files whose idea work failed (extraction, match, or persist). */
  ideaErrors: number;
}

export interface IdeaScanContext {
  /** Account root folder id — the org-scope key on idea rows. */
  accountExternalId: string;
  accountName: string | null;
  /** false = dry-run: extract + match in memory, write nothing. */
  apply: boolean;
  stats: IdeaScanStats;
  /** Lazy per-scan cache of the account's ideas; advanced in memory. */
  known: KnownIdea[] | null;
}

export function createIdeaScanContext(args: {
  accountExternalId: string;
  accountName: string | null;
  apply: boolean;
}): IdeaScanContext {
  return {
    accountExternalId: args.accountExternalId,
    accountName: args.accountName,
    apply: args.apply,
    stats: { deckFiles: 0, ideasCreated: 0, ideasUpdated: 0, ideasUnchanged: 0, ideaErrors: 0 },
    known: null,
  };
}

/**
 * Run idea extraction + match/merge/persist for one file. No-op unless the
 * per-file extractor classified it as a pitch / creative-review deck.
 * Never throws — idea failures must not fail the file's observation flow.
 */
export async function processFileIdeas(
  ctx: IdeaScanContext,
  args: {
    file: TraversedFile;
    text: string;
    deckType: PerFileDeckType;
    /** Folder id of the owning campaign (external ref on the idea row). */
    campaignExternalId: string | null;
  },
): Promise<void> {
  if (args.deckType === 'other') return;
  ctx.stats.deckFiles += 1;

  try {
    const res = await extractIdeasFromFile({
      file: args.file,
      text: args.text,
      accountName: ctx.accountName,
    });
    if (res.ideas.length === 0) return;

    if (ctx.known === null) {
      ctx.known = (
        await prisma.idea.findMany({
          where: { accountExternalId: ctx.accountExternalId },
          select: { id: true, name: true, facets: true },
          orderBy: { createdAt: 'asc' },
        })
      ).map((k) => ({ id: k.id, name: k.name, facets: k.facets }));
    }

    for (const idea of res.ideas) {
      let matchId: string | null;
      let mergedFacets: string[];
      try {
        ({ matchId, mergedFacets } = await matchAndMergeIdea({
          newIdea: idea,
          existingIdeas: ctx.known,
          accountName: ctx.accountName,
        }));
      } catch (err) {
        // Matcher failure must not lose the idea — fall back to a plain create.
        logger.warn({ err, ideaName: idea.name }, '[drive.idea-scan] match failed — creating as new');
        matchId = null;
        mergedFacets = idea.facets;
      }

      if (matchId) {
        const target = ctx.known.find((k) => k.id === matchId)!;
        if (facetsEqual(target.facets, mergedFacets)) {
          ctx.stats.ideasUnchanged += 1;
          continue;
        }
        if (ctx.apply && !target.id.startsWith('dryrun:')) {
          await prisma.$transaction([
            prisma.idea.update({ where: { id: target.id }, data: { facets: mergedFacets } }),
            prisma.ideaChange.create({
              data: {
                ideaId: target.id,
                property: 'facets',
                previousValueText: renderFacets(target.facets),
                valueText: renderFacets(mergedFacets),
                changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
              },
            }),
          ]);
        }
        target.facets = mergedFacets; // advance the in-memory memory
        ctx.stats.ideasUpdated += 1;
      } else {
        let newId = `dryrun:${ctx.stats.ideasCreated}`;
        if (ctx.apply) {
          const created = await prisma.$transaction(async (tx) => {
            const c = await tx.idea.create({
              data: {
                accountExternalId: ctx.accountExternalId,
                ...(args.campaignExternalId ? { campaignExternalId: args.campaignExternalId } : {}),
                name: idea.name,
                facets: mergedFacets,
                sourceFileId: args.file.id,
              },
            });
            await tx.ideaChange.create({
              data: {
                ideaId: c.id,
                property: 'facets',
                previousValueText: null,
                valueText: renderFacets(mergedFacets),
                changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
              },
            });
            return c;
          });
          newId = created.id;
        }
        ctx.known.push({ id: newId, name: idea.name, facets: mergedFacets });
        ctx.stats.ideasCreated += 1;
      }
    }
  } catch (err) {
    ctx.stats.ideaErrors += 1;
    logger.warn(
      { err, fileId: args.file.id, fileName: args.file.name },
      '[drive.idea-scan] idea work failed for file — observations unaffected',
    );
  }
}
