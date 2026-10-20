/**
 * drive/folder-tree.ts — the in-memory parent map behind the flat listing.
 *
 * A flat `corpora=drive` listing returns every folder of a shared drive with
 * its parent pointer, in no useful order. buildTreeFromFlat cuts the subtree
 * under any root out of it — the drive itself or a folder inside it — and
 * returns what walkFoldersRecursive returns for that root: the same nodes,
 * breadcrumb paths, depths and parent ids. Switching a root from the walk to
 * the flat listing therefore leaves its structure fingerprint, its
 * attribution and every file path unchanged.
 *
 * That holds for trees whose folders have one parent each, which is every
 * shared drive (Drive allows no second parent there). A legacy multi-parent
 * folder appears once, under parents[0]; the walk lists it under each parent.
 *
 * The map is rebuilt from a fresh listing on every gather, so a move or a
 * rename is simply the next listing's truth; nothing stale carries over.
 *
 * Pure: no Drive client, config or DB, so the unit suite runs it bare.
 */

import type { DriveFolderRec } from './client';
import type { FolderNode } from './structure';

// Drive's own nesting limit. The one cap for every listing: traversal.ts and
// structure.ts import it, so the walks and the flat listing cut alike.
export const MAX_DEPTH = 100;

/**
 * Counters for one flat listing cut to one root, counted in ONE unit: folders
 * (`[drive.structure] parent map`, kind=folders) or files (the discovery
 * `Parent map (files):` line). The keys are log keys: add, never rename.
 */
export interface ParentMapStats {
  /**
   * Items kept. Folders: the subtree's folders. Files: files whose parent is
   * the root or a subtree folder above the depth cap.
   */
  in_scope: number;
  /**
   * Items whose parent chain reaches the drive root without passing the
   * root. For a root inside a drive this is the rest of the drive, a size
   * figure rather than a move signal; for the drive root it is always 0.
   */
  out_of_scope: number;
  /** Items whose parent chain breaks: a parent missing from the listing, no parent, or a loop. */
  orphans: number;
  /**
   * Items of the whole listing (in scope or not) with more than one parent;
   * parents[0] is used, as everywhere.
   */
  multi_parent: number;
  /** Subtree folders at the depth cap: their contents are not listed. */
  depth_cap: number;
}

export type Reach = 'in' | 'out' | 'orphan';

/**
 * Where a folder's parent chain leads: to the root ('in'), to the drive root
 * without passing the root ('out'), or nowhere ('orphan': a parent missing
 * from the listing, no parent at all, or a loop). Iterative and memoized, so
 * classifying every item of a large drive stays linear.
 */
export function makeReach(
  rootId: string,
  driveId: string,
  flat: DriveFolderRec[],
): (folderId: string | null | undefined) => Reach {
  const parentById = new Map(flat.map((f) => [f.id, f.parentId]));
  const memo = new Map<string, Reach>();
  return (start) => {
    const chain: string[] = [];
    const onChain = new Set<string>();
    let id: string | null | undefined = start;
    let result: Reach;
    for (;;) {
      if (id === rootId) {
        result = 'in';
        break;
      }
      // The drive root is checked after the root, so it reads 'in' when the
      // root IS the drive.
      if (id === driveId) {
        result = 'out';
        break;
      }
      if (!id || onChain.has(id) || !parentById.has(id)) {
        result = 'orphan';
        break;
      }
      const known = memo.get(id);
      if (known) {
        result = known;
        break;
      }
      chain.push(id);
      onChain.add(id);
      id = parentById.get(id);
    }
    for (const c of chain) memo.set(c, result);
    return result;
  };
}

/**
 * A changed file seen by the forward run whose parent is neither the root
 * nor a folder in the run's gathered map: moved out of the tree, or under a
 * parent the bot cannot see.
 */
export function isOutsideFolderMap(
  parentId: string | null,
  rootId: string,
  folderPathById: ReadonlyMap<string, string>,
): boolean {
  if (parentId === rootId) return false;
  return !(parentId && folderPathById.has(parentId));
}

/**
 * Counters for a folder listing: `folders` is buildTreeFromFlat's output for
 * the same root and listing. The root folder itself is not counted.
 */
export function folderMapStats(
  rootId: string,
  driveId: string,
  flat: DriveFolderRec[],
  folders: FolderNode[],
): ParentMapStats {
  const reach = makeReach(rootId, driveId, flat);
  let outOfScope = 0;
  let orphans = 0;
  let multiParent = 0;
  for (const f of flat) {
    if (f.parentCount > 1) multiParent++;
    if (f.id === rootId) continue;
    const r = reach(f.parentId);
    if (r === 'out') outOfScope++;
    else if (r === 'orphan') orphans++;
  }
  return {
    in_scope: folders.length,
    out_of_scope: outOfScope,
    orphans,
    multi_parent: multiParent,
    depth_cap: folders.filter((f) => f.depth > MAX_DEPTH).length,
  };
}

/**
 * Reconstruct a depth-first folder tree from a flat folder list (each with
 * an immediate parentId). Cycle-safe (visited set) and depth-capped.
 */
export function buildTreeFromFlat(
  rootId: string,
  rootLabel: string,
  flat: DriveFolderRec[],
): FolderNode[] {
  const childrenByParent = new Map<string, DriveFolderRec[]>();
  for (const f of flat) {
    const p = f.parentId ?? '';
    const bucket = childrenByParent.get(p);
    if (bucket) bucket.push(f);
    else childrenByParent.set(p, [f]);
  }

  const out: FolderNode[] = [];
  const visited = new Set<string>();

  const descend = (parentFolderId: string, parentPath: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const kids = childrenByParent.get(parentFolderId) ?? [];
    for (const k of kids) {
      if (visited.has(k.id)) continue; // defensive against multi-parent / cycles
      visited.add(k.id);
      const path = `${parentPath} / ${k.name}`;
      // parentId is the FolderNode parent — null when the parent is the
      // account root itself (we don't model the root as a FolderNode).
      const parentIdField = parentFolderId === rootId ? null : parentFolderId;
      out.push({ id: k.id, name: k.name, path, depth: depth + 1, parentId: parentIdField });
      descend(k.id, path, depth + 1);
    }
  };

  descend(rootId, rootLabel, 0);
  return out;
}

/**
 * Where a flat-listed file belongs, by its immediate parent: the parent's
 * breadcrumb when traverseFolder would yield the file — its parent is the
 * root or a subtree folder above the depth cap — else null (outside the
 * subtree, parent not visible, or beneath the cap). `folders` is
 * buildTreeFromFlat's output for the same root.
 */
export function subtreeParentPaths(
  rootId: string,
  rootLabel: string,
  folders: FolderNode[],
): (parentId: string | null | undefined) => string | null {
  const pathById = new Map<string, string>([[rootId, rootLabel]]);
  // traverseFolder lists a folder's contents only down to depth MAX_DEPTH;
  // folders one level deeper are yielded, but their files are not.
  for (const f of folders) if (f.depth <= MAX_DEPTH) pathById.set(f.id, f.path);
  return (parentId) => (parentId ? (pathById.get(parentId) ?? null) : null);
}
