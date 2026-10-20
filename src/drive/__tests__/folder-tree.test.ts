import { describe, expect, it } from 'vitest';
import type { DriveFolderRec } from '../client';
import {
  buildTreeFromFlat,
  folderMapStats,
  isOutsideFolderMap,
  makeReach,
  MAX_DEPTH,
  subtreeParentPaths,
} from '../folder-tree';

// A synthetic shared drive. The root under test, R ("Client A"), sits two
// levels below the drive root, next to a sibling tree it must not see:
//
//   drive
//   ├── arch "Archive"
//   │   └── R "Client A"            ← root
//   │       ├── y26 "2026"
//   │       │   ├── launch "Launch"
//   │       │   └── assets "Assets"
//   │       └── admin "Admin"
//   └── other "Other client"
//       └── stuff "Stuff"
const DRIVE = 'drive';
const ROOT = 'R';
const LABEL = 'Client A';

const rec = (
  id: string,
  name: string,
  parentId: string | null,
  parentCount = 1,
): DriveFolderRec => ({
  id,
  name,
  parentId,
  parentCount,
});

const baseListing = (): DriveFolderRec[] => [
  rec('arch', 'Archive', DRIVE),
  rec(ROOT, LABEL, 'arch'),
  rec('y26', '2026', ROOT),
  rec('launch', 'Launch', 'y26'),
  rec('assets', 'Assets', 'y26'),
  rec('admin', 'Admin', ROOT),
  rec('other', 'Other client', DRIVE),
  rec('stuff', 'Stuff', 'other'),
];

const byId = (nodes: ReturnType<typeof buildTreeFromFlat>) => new Map(nodes.map((n) => [n.id, n]));

describe('buildTreeFromFlat — a subtree that is not at the drive root', () => {
  it('returns only the root’s descendants, with root-relative paths and depths', () => {
    const tree = buildTreeFromFlat(ROOT, LABEL, baseListing());
    expect(tree).toEqual([
      { id: 'y26', name: '2026', path: 'Client A / 2026', depth: 1, parentId: null },
      { id: 'launch', name: 'Launch', path: 'Client A / 2026 / Launch', depth: 2, parentId: 'y26' },
      { id: 'assets', name: 'Assets', path: 'Client A / 2026 / Assets', depth: 2, parentId: 'y26' },
      { id: 'admin', name: 'Admin', path: 'Client A / Admin', depth: 1, parentId: null },
    ]);
  });

  it('counts the rest of the drive as out_of_scope, not as orphans', () => {
    const flat = baseListing();
    const stats = folderMapStats(ROOT, DRIVE, flat, buildTreeFromFlat(ROOT, LABEL, flat));
    // arch, other and stuff reach the drive root without passing R; R itself is not counted.
    expect(stats).toEqual({
      in_scope: 4,
      out_of_scope: 3,
      orphans: 0,
      multi_parent: 0,
      depth_cap: 0,
    });
  });

  it('for the drive root itself, nothing is out of scope', () => {
    const flat = baseListing();
    const tree = buildTreeFromFlat(DRIVE, 'Drive', flat);
    expect(tree).toHaveLength(flat.length);
    expect(folderMapStats(DRIVE, DRIVE, flat, tree).out_of_scope).toBe(0);
  });
});

describe('the map follows the latest listing', () => {
  it('move: a folder moved inside the subtree gets its new parent and path', () => {
    const moved = baseListing().map((f) =>
      f.id === 'assets' ? rec('assets', 'Assets', 'admin') : f,
    );
    const node = byId(buildTreeFromFlat(ROOT, LABEL, moved)).get('assets');
    expect(node).toEqual({
      id: 'assets',
      name: 'Assets',
      path: 'Client A / Admin / Assets',
      depth: 2,
      parentId: 'admin',
    });
  });

  it('rename: renaming a folder rewrites every descendant path', () => {
    const renamed = baseListing().map((f) => (f.id === 'y26' ? rec('y26', '2027', ROOT) : f));
    const nodes = byId(buildTreeFromFlat(ROOT, LABEL, renamed));
    expect(nodes.get('y26')?.path).toBe('Client A / 2027');
    expect(nodes.get('launch')?.path).toBe('Client A / 2027 / Launch');
    expect(nodes.get('assets')?.path).toBe('Client A / 2027 / Assets');
  });

  it('move-out: a folder moved out of the subtree leaves the tree and counts as out_of_scope', () => {
    const flat = baseListing().map((f) => (f.id === 'y26' ? rec('y26', '2026', 'other') : f));
    const tree = buildTreeFromFlat(ROOT, LABEL, flat);
    expect(tree.map((n) => n.id)).toEqual(['admin']);
    const stats = folderMapStats(ROOT, DRIVE, flat, tree);
    // y26 and its two children now sit under "Other client".
    expect(stats.in_scope).toBe(1);
    expect(stats.out_of_scope).toBe(6);
  });
});

describe('broken chains', () => {
  it('orphan: a folder whose parent is not in the listing is dropped and counted', () => {
    const flat = [...baseListing(), rec('lost', 'Lost', 'ghost'), rec('lostkid', 'Kid', 'lost')];
    const tree = buildTreeFromFlat(ROOT, LABEL, flat);
    expect(tree.map((n) => n.id)).not.toContain('lost');
    const stats = folderMapStats(ROOT, DRIVE, flat, tree);
    expect(stats.orphans).toBe(2);
    expect(stats.out_of_scope).toBe(3);
  });

  it('a folder with no parent at all, and a parent loop, are orphans', () => {
    const flat = [
      ...baseListing(),
      rec('np', 'No parent', null),
      rec('l1', 'L1', 'l2'),
      rec('l2', 'L2', 'l1'),
    ];
    const stats = folderMapStats(ROOT, DRIVE, flat, buildTreeFromFlat(ROOT, LABEL, flat));
    expect(stats.orphans).toBe(3);
  });

  it('multi-parent: parents[0] places the folder, once, and the item is counted', () => {
    const flat = [...baseListing(), rec('shared', 'Shared', 'admin', 2)];
    const tree = buildTreeFromFlat(ROOT, LABEL, flat);
    expect(tree.filter((n) => n.id === 'shared')).toEqual([
      {
        id: 'shared',
        name: 'Shared',
        path: 'Client A / Admin / Shared',
        depth: 2,
        parentId: 'admin',
      },
    ]);
    expect(folderMapStats(ROOT, DRIVE, flat, tree).multi_parent).toBe(1);
  });

  it('a folder listed twice (moved while the listing paged) appears once, at its first place', () => {
    const flat = [...baseListing(), rec('assets', 'Assets', 'admin')];
    const tree = buildTreeFromFlat(ROOT, LABEL, flat);
    expect(tree.filter((n) => n.id === 'assets')).toEqual([
      {
        id: 'assets',
        name: 'Assets',
        path: 'Client A / 2026 / Assets',
        depth: 2,
        parentId: 'y26',
      },
    ]);
  });
});

describe('depth cap', () => {
  // A chain three levels past the cap: R / d1 / d2 / … / d103.
  const chain = (): DriveFolderRec[] => {
    const out = [rec(ROOT, LABEL, DRIVE)];
    for (let i = 1; i <= MAX_DEPTH + 3; i++)
      out.push(rec(`d${i}`, `L${i}`, i === 1 ? ROOT : `d${i - 1}`));
    return out;
  };

  it('keeps folders down to depth MAX_DEPTH + 1, like the recursive walk', () => {
    const tree = buildTreeFromFlat(ROOT, LABEL, chain());
    expect(tree).toHaveLength(MAX_DEPTH + 1);
    expect(tree[tree.length - 1]).toMatchObject({ id: `d${MAX_DEPTH + 1}`, depth: MAX_DEPTH + 1 });
    expect(folderMapStats(ROOT, DRIVE, chain(), tree).depth_cap).toBe(1);
  });

  it('places files only under the root or folders above the cap', () => {
    const tree = buildTreeFromFlat(ROOT, LABEL, chain());
    const parentPathOf = subtreeParentPaths(ROOT, LABEL, tree);
    expect(parentPathOf(ROOT)).toBe(LABEL);
    expect(parentPathOf(`d${MAX_DEPTH}`)).toMatch(new RegExp(` / L${MAX_DEPTH}$`));
    // traverseFolder yields the depth-101 folder but never lists its files.
    expect(parentPathOf(`d${MAX_DEPTH + 1}`)).toBeNull();
    expect(parentPathOf(`d${MAX_DEPTH + 2}`)).toBeNull();
  });
});

describe('makeReach', () => {
  it('memoizes without changing the answer', () => {
    const reach = makeReach(ROOT, DRIVE, baseListing());
    expect(['launch', 'launch', 'stuff', 'ghost', undefined, null].map((id) => reach(id))).toEqual([
      'in',
      'in',
      'out',
      'orphan',
      'orphan',
      'orphan',
    ]);
  });
});

describe('isOutsideFolderMap (forward)', () => {
  const map = new Map([['y26', 'Client A / 2026']]);

  it('accepts the root and mapped folders', () => {
    expect(isOutsideFolderMap(ROOT, ROOT, map)).toBe(false);
    expect(isOutsideFolderMap('y26', ROOT, map)).toBe(false);
  });

  it('flags a parent outside the map, and a missing parent', () => {
    expect(isOutsideFolderMap('stuff', ROOT, map)).toBe(true);
    expect(isOutsideFolderMap(null, ROOT, map)).toBe(true);
  });
});
