/**
 * drive.traversal.ts — Recursive folder walker.
 *
 * Yields every non-folder file under a root folder, with a cached breadcrumb
 * path and normalized metadata. Subfolder recursion is depth-first.
 *
 * Depth is capped as a safety rail — folders in practice are shallow.
 */

import { listFolderChildren } from './client';
import type { TraversedFile } from './types';
import { logger } from '../logger';

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
// Matches Drive's own shared-drive depth limit (100). We're not the
// bottleneck — if a tree somehow exceeds this, Drive itself would have
// rejected the structure before we ever saw it. The check stays purely
// as defense-in-depth against an infinite-recursion bug in our code.
// History: was 8 (too low — tripped on real Year/Quarter/Project trees),
// briefly 20, now 100 to match Drive on 2026-05-22.
const MAX_DEPTH = 100;

/**
 * Called when `listFolderChildren` fails on a SUBFOLDER (depth > 0).
 * The traversal silently skips that subfolder and continues with the
 * rest of the tree. Failures on the ROOT folder still throw — there's
 * nothing meaningful to scan if we can't read the root.
 */
export type OnFolderError = (
  args: { folderId: string; folderPath: string; depth: number; err: unknown },
) => void | Promise<void>;

/**
 * Called when traversal hits MAX_DEPTH and refuses to descend further.
 * Lets callers surface a count of skipped-due-to-depth subfolders so
 * operators know files deeper than the cap may have been missed.
 */
export type OnDepthCap = (
  args: { folderId: string; folderPath: string; depth: number },
) => void | Promise<void>;

export interface TraverseFolderOptions {
  onFolderError?: OnFolderError;
  onDepthCap?: OnDepthCap;
}

export async function* traverseFolder(
  rootFolderId: string,
  rootLabel: string,
  options: TraverseFolderOptions = {},
): AsyncGenerator<TraversedFile, void, void> {
  yield* walk(rootFolderId, rootLabel, 0, options);
}

async function* walk(
  folderId: string,
  folderPath: string,
  depth: number,
  options: TraverseFolderOptions,
): AsyncGenerator<TraversedFile, void, void> {
  if (depth > MAX_DEPTH) {
    // Demoted to debug: callers receive an onDepthCap callback if they
    // want to surface this to a user-facing log.
    logger.debug({ folderId, folderPath, depth }, '[drive] traversal depth cap hit');
    if (options.onDepthCap) {
      await options.onDepthCap({ folderId, folderPath, depth });
    }
    return;
  }

  let children: Awaited<ReturnType<typeof listFolderChildren>>;
  try {
    children = await listFolderChildren(folderId);
  } catch (err) {
    // Root folder unreachable is fatal — no meaningful work possible.
    // Caller (scanEntity) will catch and report as an entity-level error.
    if (depth === 0) {
      logger.debug({ err, folderId, folderPath }, '[drive] root listFolderChildren failed');
      throw err;
    }
    // Subfolder unreachable: surface via callback, then skip this branch
    // and continue with siblings. One bad-permission subfolder shouldn't
    // tank the whole entity scan.
    logger.debug({ err, folderId, folderPath, depth }, '[drive] subfolder listFolderChildren failed — skipping');
    if (options.onFolderError) {
      await options.onFolderError({ folderId, folderPath, depth, err });
    }
    return;
  }

  for (const child of children) {
    if (!child.id || !child.name || !child.mimeType) continue;
    const childPath = `${folderPath} / ${child.name}`;
    const isFolder = child.mimeType === GOOGLE_FOLDER_MIME;

    const base: TraversedFile = {
      id: child.id,
      name: child.name,
      mimeType: child.mimeType,
      ...(child.parents ? { parents: child.parents } : {}),
      path: childPath,
      modifiedTime: child.modifiedTime ?? null,
      modifiedByEmail: child.lastModifyingUser?.emailAddress ?? null,
      createdTime: child.createdTime ?? null,
      size: child.size ? Number(child.size) : null,
      isFolder,
      ...(child.shortcutDetails?.targetId && child.shortcutDetails?.targetMimeType
        ? {
            shortcutTarget: {
              id: child.shortcutDetails.targetId,
              mimeType: child.shortcutDetails.targetMimeType,
            },
          }
        : {}),
    };

    yield base;

    if (isFolder) {
      yield* walk(child.id, childPath, depth + 1, options);
    }
  }
}
