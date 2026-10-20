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

// Drive's own nesting limit; the same cap as structure.ts and traversal.ts.
export const MAX_DEPTH = 100;

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
