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
const MAX_DEPTH = 8;

export async function* traverseFolder(
  rootFolderId: string,
  rootLabel: string,
): AsyncGenerator<TraversedFile, void, void> {
  yield* walk(rootFolderId, rootLabel, 0);
}

async function* walk(
  folderId: string,
  folderPath: string,
  depth: number,
): AsyncGenerator<TraversedFile, void, void> {
  if (depth > MAX_DEPTH) {
    logger.warn({ folderId, folderPath, depth }, '[drive] traversal depth cap hit');
    return;
  }

  let children: Awaited<ReturnType<typeof listFolderChildren>>;
  try {
    children = await listFolderChildren(folderId);
  } catch (err) {
    logger.error({ err, folderId, folderPath }, '[drive] listFolderChildren failed');
    throw err;
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
      size: child.size ? Number(child.size) : null,
      isFolder,
    };

    yield base;

    if (isFolder) {
      yield* walk(child.id, childPath, depth + 1);
    }
  }
}
