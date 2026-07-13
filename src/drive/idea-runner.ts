/**
 * idea-runner.ts — orchestrates idea extraction over a target folder.
 *
 * Traverses a folder (a campaign, or any folder id), extracts each file's
 * text, runs the tightly-gated idea extractor, and collects / persists the
 * `ideas` it finds. Mirrors the BOOTSTRAP traversal (traverseFolder +
 * extractText directly — no snapshot/delta side effects), so it's safe to
 * run as a focused test without touching forward-sync state.
 *
 * The idea extractor self-gates (deck_type='other' → no ideas), so pointing
 * this at a whole campaign folder is fine — only actual pitch / creative-review
 * decks yield ideas. (The interpret-level deck_type gate is the cost
 * optimization for the FULL bootstrap over thousands of files; for a focused
 * run we let each file self-gate.)
 *
 * Dry-run (apply=false) reports what it found; --confirm persists.
 */

import { prisma } from '../prisma';
import { logger } from '../logger';
import { traverseFolder } from './traversal';
import { gatherFolders } from './structure';
import { extractText } from './extract';
import { extractIdeasFromFile, type DeckType, type ExtractedIdea } from './idea-extraction';
import { matchAndMergeIdea, type KnownIdea } from './idea-matcher';
import { DRIVE_SYNC_SYSTEM_STAFF_ID } from './heal';

export interface RunIdeaExtractionOptions {
  folderId: string;
  folderLabel: string;
  accountName: string | null;
  /** Persisted on each idea row as the org-scope reference. */
  accountExternalId: string;
  /** Persisted on each idea row (nullable). */
  campaignExternalId?: string;
  apply: boolean;
}

export interface IdeaRunFileResult {
  fileName: string;
  filePath: string;
  fileId: string;
  deckType: DeckType;
  ideas: ExtractedIdea[];
}

/**
 * One resolved idea AFTER match-and-merge collapse — what actually lands (or
 * would land) in the memory tier. `contributingDecks` is how many extracted
 * ideas folded into this one (BHAC's ~9 character-generator variants → 1).
 */
export interface ResolvedIdea {
  action: 'create' | 'update';
  /** Present when action='update' (or after a create is persisted). */
  ideaId?: string;
  name: string;
  facets: string[];
  contributingDecks: number;
}

export interface IdeaRunResult {
  folderId: string;
  apply: boolean;
  filesSeen: number;
  filesExtracted: number;
  extractionErrors: number;
  deckFiles: number;
  ideasFound: number;
  /** Distinct ideas after collapse (created + updated). */
  ideasResolved: number;
  ideasCreated: number;
  ideasUpdated: number;
  /** No-op merges: a deck re-stated an idea with nothing new (idempotent). */
  ideasUnchanged: number;
  ideasPersisted: number;
  /** Change-log rows written (creates + non-empty updates). */
  changesLogged: number;
  /** Persist-phase writes that failed and were skipped (apply mode only). */
  persistErrors: number;
  files: IdeaRunFileResult[];
  resolved: ResolvedIdea[];
}

/** A single planned mutation, built during resolution, executed during persist. */
interface PlannedEvent {
  kind: 'create' | 'update' | 'noop';
  /** Real uuid for an existing idea, or a synthetic `new:N` for a planned create. */
  targetId: string;
  name: string;
  previousFacets: string[];
  facets: string[];
  sourceFileId: string;
}

export function renderFacets(facets: string[]): string {
  return facets.map((f) => `- ${f}`).join('\n');
}

/** Order-insensitive set equality — skip no-op updates so re-runs don't churn. */
export function facetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (xs: string[]) => new Set(xs.map((x) => x.trim().toLowerCase()));
  const sa = norm(a);
  for (const x of norm(b)) if (!sa.has(x)) return false;
  return true;
}

export async function runIdeaExtraction(opts: RunIdeaExtractionOptions): Promise<IdeaRunResult> {
  const files: IdeaRunFileResult[] = [];
  let filesSeen = 0;
  let filesExtracted = 0;
  let extractionErrors = 0;
  let deckFiles = 0;
  let ideasFound = 0;

  for await (const file of traverseFolder(opts.folderId, opts.folderLabel, {})) {
    if (file.isFolder) continue;
    filesSeen++;

    // Per-file try/catch — one unreadable file (a doc not shared with the bot,
    // a corrupt export, an LLM hiccup) must not kill the whole run. Same
    // discipline as the bootstrap's scanFolder/processFile.
    try {
      const outcome = await extractText(file);
      if (outcome.kind !== 'ok') continue;
      filesExtracted++;

      const res = await extractIdeasFromFile({
        file,
        text: outcome.text,
        accountName: opts.accountName,
      });

      if (res.deckType !== 'other') deckFiles++;
      if (res.ideas.length > 0) {
        ideasFound += res.ideas.length;
        files.push({
          fileName: file.name,
          filePath: file.path,
          fileId: file.id,
          deckType: res.deckType,
          ideas: res.ideas,
        });
        logger.info(
          { fileName: file.name, deckType: res.deckType, ideaCount: res.ideas.length },
          '[drive.idea-runner] ideas found',
        );
      }
    } catch (err) {
      extractionErrors++;
      logger.warn({ err, fileId: file.id, fileName: file.name }, '[drive.idea-runner] file failed — skipped');
    }
  }

  // ── Phase 2: RESOLVE — match each extracted idea against the account's
  // memory and merge (add + supersede) rather than snapshot per deck. Runs in
  // BOTH dry-run and apply so the preview shows the real collapse; only Phase 3
  // writes. `known` is the growing set (persisted ideas + creates planned this
  // run), so duplicates within a single run collapse too — BHAC's first deck
  // creates the idea, the rest merge into it.
  const known: KnownIdea[] = (
    await prisma.idea.findMany({
      where: { accountExternalId: opts.accountExternalId },
      select: { id: true, name: true, facets: true },
      orderBy: { createdAt: 'asc' },
    })
  ).map((k) => ({ id: k.id, name: k.name, facets: k.facets }));

  const events: PlannedEvent[] = [];
  const decksInto = new Map<string, number>(); // targetId → # of decks folded in
  let synthSeq = 0;

  for (const f of files) {
    for (const idea of f.ideas) {
      let matchId: string | null;
      let mergedFacets: string[];
      try {
        ({ matchId, mergedFacets } = await matchAndMergeIdea({
          newIdea: idea,
          existingIdeas: known,
          accountName: opts.accountName,
        }));
      } catch (err) {
        // Matcher failure must not lose the idea — fall back to a plain create.
        logger.warn({ err, ideaName: idea.name }, '[drive.idea-runner] match failed — creating as new');
        matchId = null;
        mergedFacets = idea.facets;
      }

      if (matchId) {
        const target = known.find((k) => k.id === matchId)!;
        // Base 0 for the match path: a pre-existing idea has no prior entry, so
        // its first deck this run must count as 1 (0+1). Creates seed 1 below,
        // so a same-run create-then-match still climbs 1→2 correctly.
        decksInto.set(matchId, (decksInto.get(matchId) ?? 0) + 1);
        if (facetsEqual(target.facets, mergedFacets)) {
          events.push({ kind: 'noop', targetId: matchId, name: target.name, previousFacets: target.facets, facets: target.facets, sourceFileId: f.fileId });
        } else {
          events.push({ kind: 'update', targetId: matchId, name: target.name, previousFacets: target.facets, facets: mergedFacets, sourceFileId: f.fileId });
          target.facets = mergedFacets; // advance the in-memory memory
        }
      } else {
        const synthId = `new:${synthSeq++}`;
        known.push({ id: synthId, name: idea.name, facets: mergedFacets });
        decksInto.set(synthId, 1);
        events.push({ kind: 'create', targetId: synthId, name: idea.name, previousFacets: [], facets: mergedFacets, sourceFileId: f.fileId });
      }
    }
  }

  // ── Phase 3: PERSIST (apply only). Creates first map their synthetic id to a
  // real uuid; later updates that target a same-run create resolve through it.
  // Per-event try/catch mirrors Phase 1/2: one failed write must not abort the
  // rest of the run — a re-run heals a partial apply (created ideas land in
  // `known` and re-match, so only the un-applied ideas are retried).
  const realId = new Map<string, string>();
  let ideasPersisted = 0;
  let changesLogged = 0;
  let persistErrors = 0;
  if (opts.apply) {
    for (const ev of events) {
      try {
        if (ev.kind === 'create') {
          // Entity + birth change-log written atomically — same discipline as
          // the update branch and heal.ts. A create that committed without its
          // birth row would leave the change log permanently incomplete (the
          // ideas tier has no rebuild source to reconcile from).
          const created = await prisma.$transaction(async (tx) => {
            const c = await tx.idea.create({
              data: {
                accountExternalId: opts.accountExternalId,
                ...(opts.campaignExternalId ? { campaignExternalId: opts.campaignExternalId } : {}),
                name: ev.name,
                facets: ev.facets,
                sourceFileId: ev.sourceFileId,
              },
            });
            await tx.ideaChange.create({
              data: {
                ideaId: c.id,
                property: 'facets',
                previousValueText: null,
                valueText: renderFacets(ev.facets),
                changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
              },
            });
            return c;
          });
          realId.set(ev.targetId, created.id);
          ideasPersisted++;
          changesLogged++;
        } else if (ev.kind === 'update') {
          const id = realId.get(ev.targetId) ?? ev.targetId;
          // An unresolved synthetic id means this update targets a create that
          // failed earlier this run — skip rather than write against a non-uuid.
          if (id.startsWith('new:')) {
            persistErrors++;
            logger.warn({ targetId: ev.targetId, name: ev.name }, '[drive.idea-runner] update skipped — its create failed');
            continue;
          }
          await prisma.$transaction([
            prisma.idea.update({ where: { id }, data: { facets: ev.facets } }),
            prisma.ideaChange.create({
              data: {
                ideaId: id,
                property: 'facets',
                previousValueText: renderFacets(ev.previousFacets),
                valueText: renderFacets(ev.facets),
                changedBy: DRIVE_SYNC_SYSTEM_STAFF_ID,
              },
            }),
          ]);
          changesLogged++;
        }
        // noop: idea re-stated with nothing new — no write.
      } catch (err) {
        persistErrors++;
        logger.warn({ err, kind: ev.kind, name: ev.name, sourceFileId: ev.sourceFileId }, '[drive.idea-runner] persist failed — skipped');
      }
    }
  }

  // Fold the event stream into the resolved (post-collapse) idea view.
  const resolvedMap = new Map<string, ResolvedIdea>();
  for (const ev of events) {
    if (ev.kind === 'create') {
      resolvedMap.set(ev.targetId, {
        action: 'create',
        ...(realId.has(ev.targetId) ? { ideaId: realId.get(ev.targetId)! } : {}),
        name: ev.name,
        facets: ev.facets,
        contributingDecks: decksInto.get(ev.targetId) ?? 1,
      });
    } else {
      const existing = resolvedMap.get(ev.targetId);
      if (existing) {
        existing.facets = ev.facets; // latest merged state
      } else {
        // Update to a PRE-EXISTING idea (not created this run).
        resolvedMap.set(ev.targetId, {
          action: 'update',
          ideaId: ev.targetId,
          name: ev.name,
          facets: ev.facets,
          contributingDecks: decksInto.get(ev.targetId) ?? 1,
        });
      }
    }
  }
  const resolved = [...resolvedMap.values()];
  const ideasCreated = resolved.filter((r) => r.action === 'create').length;
  const ideasUpdated = resolved.filter((r) => r.action === 'update').length;
  const ideasUnchanged = events.filter((e) => e.kind === 'noop').length;

  logger.info(
    { folderId: opts.folderId, apply: opts.apply, filesSeen, deckFiles, ideasFound, ideasResolved: resolved.length, ideasCreated, ideasUpdated, ideasPersisted, changesLogged, persistErrors },
    '[drive.idea-runner] complete',
  );

  return {
    folderId: opts.folderId,
    apply: opts.apply,
    filesSeen,
    filesExtracted,
    extractionErrors,
    deckFiles,
    ideasFound,
    ideasResolved: resolved.length,
    ideasCreated,
    ideasUpdated,
    ideasUnchanged,
    ideasPersisted,
    changesLogged,
    persistErrors,
    files,
    resolved,
  };
}

/**
 * Resolve the target for a focused run: a specific campaign (by name, →
 * its drive_folder_id) or a raw folder id. Returns the folder to traverse
 * plus the external ids to stamp on persisted rows.
 */
export async function resolveIdeaTarget(args: {
  accountName?: string;
  accountId?: string;
  campaignName?: string;
  folderId?: string;
}): Promise<{
  folderId: string;
  folderLabel: string;
  accountName: string | null;
  accountExternalId: string;
  campaignExternalId?: string;
}> {
  const account =
    args.accountId || args.accountName
      ? await prisma.account.findFirst({
          where: args.accountId
            ? { id: args.accountId }
            : { name: { contains: args.accountName!, mode: 'insensitive' } },
          select: { id: true, name: true, driveFolderId: true },
        })
      : null;
  if (!account) throw new Error('account not found — pass --account-name or --account-id');
  if (!account.driveFolderId) throw new Error(`account "${account.name}" has no drive_folder_id`);

  // Target by campaign name → its folder; else by explicit --folder-id.
  if (args.campaignName) {
    // First try a bootstrapped campaign row (fast).
    const campaign = await prisma.campaign.findFirst({
      where: { accountId: account.id, name: { contains: args.campaignName, mode: 'insensitive' } },
      select: { name: true, driveFolderId: true },
    });
    if (campaign?.driveFolderId) {
      return {
        folderId: campaign.driveFolderId,
        folderLabel: `${account.name} / ${campaign.name}`,
        accountName: account.name,
        accountExternalId: account.driveFolderId,
        campaignExternalId: campaign.driveFolderId,
      };
    }

    // Fallback: no campaign row (e.g. account was nuked) — find the folder by
    // name in the account's Drive tree. Prefer the shallowest match (the
    // campaign root over a sub-folder that happens to share the word).
    logger.info(
      { accountName: account.name, campaignName: args.campaignName },
      '[drive.idea-runner] no campaign row — searching Drive folders by name',
    );
    const folders = await gatherFolders(account.driveFolderId, account.name);
    const needle = args.campaignName.toLowerCase();
    const match = folders
      .filter((f) => f.name.toLowerCase().includes(needle))
      .sort((a, b) => a.depth - b.depth)[0];
    if (!match) {
      throw new Error(
        `no campaign row or Drive folder matching "${args.campaignName}" under ${account.name} — pass --folder-id <drive folder id> explicitly`,
      );
    }
    return {
      folderId: match.id,
      folderLabel: `${account.name} / ${match.name}`,
      accountName: account.name,
      accountExternalId: account.driveFolderId,
      campaignExternalId: match.id,
    };
  }

  if (args.folderId) {
    return {
      folderId: args.folderId,
      folderLabel: `${account.name} / (folder ${args.folderId})`,
      accountName: account.name,
      accountExternalId: account.driveFolderId,
      campaignExternalId: args.folderId,
    };
  }

  throw new Error('pass --campaign-name <name> or --folder-id <drive folder id> to target a folder');
}
