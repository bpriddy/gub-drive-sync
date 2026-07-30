/**
 * drive.sync.ts — Phase 3 core: traverse + extract + snapshot.
 *
 * v0 focus is correctness + observability, not speed. Phase 4 adds Gemini
 * interpretation on top of the extraction callback; Phase 5 wraps this with
 * weekly pacing across all accounts/campaigns.
 *
 * Public API:
 *   scanFolder({ folderId, scope, syncRunId, onExtract? })
 *     → traverses the folder, writes a snapshot per file, routes skips to
 *       scan logs, and calls `onExtract` with extracted text for each file
 *       the delta check says is fresh.
 *
 * `onExtract` is optional so this phase can run end-to-end and produce
 * observable state without any LLM dependency.
 */

import { logger } from '../logger';
import { progress, serializeError, summarizeError } from '../progress';
import { extractText } from './extract';
import { writeScanLog, type ScanLogCategory } from './logs';
import { checkDelta, writeSnapshot } from './snapshot';
import { traverseFolder } from './traversal';
import type { ExtractionResult, TraversalScope, TraversedFile } from './types';

export interface ScanFolderInput {
  folderId: string;
  /** Human-readable label for traversal paths, e.g. "Acme / Q3 Launch". */
  folderLabel: string;
  scope: TraversalScope;
  syncRunId: string | null;
  /**
   * Called once per file for which extraction succeeded AND the delta check
   * said to re-extract. Phase 4 will wire Gemini in here.
   */
  onExtract?: (file: TraversedFile, extraction: ExtractionResult) => Promise<void>;
}

export interface ScanFolderResult {
  filesSeen: number;
  filesExtracted: number;
  filesSkippedDelta: number;
  filesSkippedMime: number;
  filesSkippedSize: number;
  filesEmpty: number;
  folders: number;
  errors: number;
}

export async function scanFolder(input: ScanFolderInput): Promise<ScanFolderResult> {
  const result: ScanFolderResult = {
    filesSeen: 0,
    filesExtracted: 0,
    filesSkippedDelta: 0,
    filesSkippedMime: 0,
    filesSkippedSize: 0,
    filesEmpty: 0,
    folders: 0,
    errors: 0,
  };

  for await (const file of traverseFolder(input.folderId, input.folderLabel, {
    // Subfolder permission errors don't kill the entity scan anymore —
    // they get surfaced here and the traversal continues with siblings.
    onFolderError: async ({ folderPath, err }) => {
      result.errors++;
      progress.fileSkip(`<subfolder> ${folderPath}`, 'unreadable', summarizeError(err));
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: input.scope.accountId,
        campaignId: input.scope.campaignId,
        level: 'warn',
        category: 'traversal_error',
        message: `Subfolder unreadable: ${summarizeError(err)}`,
        payload: {
          path: folderPath,
          error: serializeError(err),
        },
      });
    },
    // Files deeper than MAX_DEPTH are NOT listed; surface the count.
    onDepthCap: async ({ folderPath, depth }) => {
      progress.fileSkip(`<subfolder> ${folderPath}`, 'past_depth_cap', `depth=${depth}`);
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: input.scope.accountId,
        campaignId: input.scope.campaignId,
        level: 'warn',
        category: 'traversal_error',
        message: `Subfolder past depth cap (depth=${depth}): files beneath NOT listed`,
        payload: { path: folderPath, depth },
      });
    },
  })) {
    if (file.isFolder) {
      result.folders++;
      continue;
    }
    result.filesSeen++;

    try {
      await processFile(file, input, result);
    } catch (err) {
      result.errors++;
      // Demoted to debug: the full error (including stack + googleapis
      // metadata) lands in drive_scan_logs.payload below. The streaming
      // logger gets a single-line summary via progress.fileError().
      logger.debug({ err, fileId: file.id, path: file.path }, '[drive.sync] file failed');
      progress.fileError(file.name, summarizeError(err));
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: input.scope.accountId,
        campaignId: input.scope.campaignId,
        fileId: file.id,
        level: 'error',
        category: 'extract_error',
        message: err instanceof Error ? err.message : String(err),
        payload: {
          path: file.path,
          mimeType: file.mimeType,
          error: serializeError(err),
        },
      });
      // Record a snapshot so we don't retry this identical version forever.
      await writeSnapshot({
        syncRunId: input.syncRunId,
        scope: input.scope,
        file,
        wasExtracted: false,
        skipReason: 'extract_error',
      });
    }
  }

  return result;
}

async function processFile(
  file: TraversedFile,
  input: ScanFolderInput,
  result: ScanFolderResult,
): Promise<void> {
  // 1. Delta: can we skip extraction entirely?
  const delta = await checkDelta(file);
  if (!delta.shouldExtract) {
    result.filesSkippedDelta++;
    await writeSnapshot({
      syncRunId: input.syncRunId,
      scope: input.scope,
      file,
      wasExtracted: false,
      skipReason: 'delta_unchanged',
    });
    return;
  }

  // 2. Extract.
  const outcome = await extractText(file);

  if (outcome.kind === 'skip') {
    const category: ScanLogCategory =
      outcome.reason === 'too_large'
        ? 'skipped_size'
        : outcome.reason === 'unsupported_mime'
          ? 'skipped_mime'
          : 'diagnostic';

    if (outcome.reason === 'too_large') result.filesSkippedSize++;
    else if (outcome.reason === 'unsupported_mime') result.filesSkippedMime++;
    else if (outcome.reason === 'empty') result.filesEmpty++;

    // Folder/empty/etc. still deserve a snapshot for history; only log the
    // ones worth surfacing in the UI.
    if (outcome.reason !== 'folder') {
      progress.fileSkip(file.name, outcome.reason, outcome.detail ?? null);
      await writeScanLog({
        syncRunId: input.syncRunId,
        accountId: input.scope.accountId,
        campaignId: input.scope.campaignId,
        fileId: file.id,
        level: 'info',
        category,
        message: `Skipped file (${outcome.reason})`,
        payload: { path: file.path, mimeType: file.mimeType, detail: outcome.detail },
      });
    }
    await writeSnapshot({
      syncRunId: input.syncRunId,
      scope: input.scope,
      file,
      wasExtracted: false,
      skipReason: outcome.reason,
    });
    return;
  }

  // 3. Extracted — hand off to the caller (Phase 4 will put Gemini here),
  //    then record the snapshot with the content hash.
  if (input.onExtract) {
    await input.onExtract(file, outcome);
  }

  await writeSnapshot({
    syncRunId: input.syncRunId,
    scope: input.scope,
    file,
    wasExtracted: true,
    contentHash: outcome.contentHash,
  });
  result.filesExtracted++;
}
