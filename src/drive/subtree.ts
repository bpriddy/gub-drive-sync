/**
 * drive/subtree.ts — every file under a root in a shared drive, from a flat
 * listing of the drive instead of one files.list per folder.
 *
 * Two sweeps of the drive at 1000 items per page, folders then non-folders:
 * O(drive items / 1000) calls, whatever the subtree's size. The folder sweep
 * builds the parent map (drive/folder-tree.ts). The file sweep keeps a file
 * only when traverseFolder would have yielded it, with the same breadcrumb
 * path, so a caller can swap the walk for this without changing a path. For
 * the drive root itself the subtree is the whole drive.
 *
 * Folders come first so the file sweep can filter each page as it arrives:
 * a small root in a big drive never holds the rest of the drive's files.
 *
 * Two limits, both shared with the walk:
 *   - The sweeps are not one snapshot. A folder created between them leaves
 *     its files without a known parent: they count as orphans and wait for
 *     the next listing, as the walk misses a folder created after its parent
 *     was listed.
 *   - Order. Files come in createdTime order; the caller's stable sort keeps
 *     it. Files with the very same createdTime can come out in a different
 *     order than the walk's depth-first one.
 */

import type { drive_v3 } from 'googleapis';
import { FlatListingUnavailableError, listAllFoldersInDrive, listDriveFilesFlat } from './client';
import {
  buildTreeFromFlat,
  makeReach,
  MAX_DEPTH,
  subtreeParentPaths,
  type ParentMapStats,
} from './folder-tree';
import type { FolderNode } from './structure';
import type { TraversedFile } from './types';

export interface SubtreeFiles {
  /** Non-folder files under the root, in listing order. */
  files: TraversedFile[];
  /**
   * The subtree's folders, the root excluded, depth-first: the tree the file
   * paths were cut from. A caller that must tell which folder owns a file
   * (the index catch-up's campaign attribution) walks `parentId` up it.
   */
  folders: FolderNode[];
  /** Folders in the subtree, the root excluded. */
  folderCount: number;
  /** Folders at the depth cap: like traverseFolder, their files are not listed. */
  depthCapHits: number;
  /** The file sweep's parent-map counters (depth_cap = depthCapHits). */
  stats: ParentMapStats;
}

export async function listSubtreeFiles(
  rootId: string,
  rootLabel: string,
  driveId: string,
): Promise<SubtreeFiles> {
  const flatFolders = await listAllFoldersInDrive(driveId);
  // A listing without the root folder cannot be cut to its subtree; an empty
  // cut would read as an empty folder. The caller treats it as a refusal.
  if (rootId !== driveId && !flatFolders.some((f) => f.id === rootId)) {
    throw new FlatListingUnavailableError('root folder is not in the drive listing');
  }
  const folders = buildTreeFromFlat(rootId, rootLabel, flatFolders);
  const parentPathOf = subtreeParentPaths(rootId, rootLabel, folders);
  const reach = makeReach(rootId, driveId, flatFolders);
  const depthCapHits = folders.filter((f) => f.depth > MAX_DEPTH).length;
  const stats: ParentMapStats = {
    in_scope: 0,
    out_of_scope: 0,
    orphans: 0,
    multi_parent: 0,
    depth_cap: depthCapHits,
  };

  const raw = await listDriveFilesFlat(driveId, (f) => {
    if (!f.id || !f.name || !f.mimeType) return false;
    if ((f.parents?.length ?? 0) > 1) stats.multi_parent++;
    const parentId = f.parents?.[0];
    if (parentPathOf(parentId) !== null) {
      stats.in_scope++;
      return true;
    }
    const r = reach(parentId);
    if (r === 'out') stats.out_of_scope++;
    else if (r === 'orphan') stats.orphans++;
    // 'in' here means beneath the depth cap: not listed, as in traverseFolder.
    return false;
  });
  const files = raw.map((f) => toTraversedFile(f, `${parentPathOf(f.parents?.[0])} / ${f.name}`));
  return { files, folders, folderCount: folders.length, depthCapHits, stats };
}

/** The same shape traverseFolder yields, plus the flat listing's content markers. */
function toTraversedFile(f: drive_v3.Schema$File, path: string): TraversedFile {
  return {
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    ...(f.parents ? { parents: f.parents } : {}),
    path,
    modifiedTime: f.modifiedTime ?? null,
    modifiedByEmail: f.lastModifyingUser?.emailAddress ?? null,
    createdTime: f.createdTime ?? null,
    size: f.size ? Number(f.size) : null,
    isFolder: false,
    ...(f.shortcutDetails?.targetId && f.shortcutDetails?.targetMimeType
      ? {
          shortcutTarget: {
            id: f.shortcutDetails.targetId,
            mimeType: f.shortcutDetails.targetMimeType,
          },
        }
      : {}),
    ...(f.version ? { version: f.version } : {}),
    ...(f.md5Checksum ? { md5Checksum: f.md5Checksum } : {}),
  };
}
