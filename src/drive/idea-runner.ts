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

export interface IdeaRunResult {
  folderId: string;
  apply: boolean;
  filesSeen: number;
  filesExtracted: number;
  extractionErrors: number;
  deckFiles: number;
  ideasFound: number;
  ideasPersisted: number;
  files: IdeaRunFileResult[];
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
          '[idea-runner] ideas found',
        );
      }
    } catch (err) {
      extractionErrors++;
      logger.warn({ err, fileId: file.id, fileName: file.name }, '[idea-runner] file failed — skipped');
    }
  }

  let ideasPersisted = 0;
  if (opts.apply && ideasFound > 0) {
    for (const f of files) {
      for (const idea of f.ideas) {
        await prisma.idea.create({
          data: {
            accountExternalId: opts.accountExternalId,
            ...(opts.campaignExternalId ? { campaignExternalId: opts.campaignExternalId } : {}),
            name: idea.name,
            facets: idea.facets,
            sourceFileId: f.fileId,
          },
        });
        ideasPersisted++;
      }
    }
  }

  logger.info(
    { folderId: opts.folderId, apply: opts.apply, filesSeen, deckFiles, ideasFound, ideasPersisted },
    '[idea-runner] complete',
  );

  return {
    folderId: opts.folderId,
    apply: opts.apply,
    filesSeen,
    filesExtracted,
    extractionErrors,
    deckFiles,
    ideasFound,
    ideasPersisted,
    files,
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
      '[idea-runner] no campaign row — searching Drive folders by name',
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
