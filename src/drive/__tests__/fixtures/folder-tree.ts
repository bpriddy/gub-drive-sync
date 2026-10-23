/**
 * A small synthetic account tree for the folder-classify tests (#69). Names
 * are generic; ids are made up. Depths follow FolderNode: the account
 * root's children are depth 1.
 *
 *   Clients            1
 *     2025             2
 *       Spring Launch  3   anchor (existing campaign)
 *         Creative     4
 *           Round 1    5
 *             Exports  6
 *       Holiday Push   3   classified new_campaign on the previous run
 *         Decks        4
 *     Archive          2
 *       Old Pitch      3
 *         Assets       4
 *           Deep A     5
 *             Deep B   6
 *               Legacy 7   anchor below the cap
 *                 Files 8
 *               Spare  7
 *   Brand              1
 *     Logos            2
 */
import type { ExistingCampaignAnchor, FolderNode } from '../../structure';

export const ROOT_ID = 'root-0';
export const ACCOUNT_NAME = 'Account One';

function node(
  id: string,
  name: string,
  depth: number,
  parentId: string | null,
  path: string,
): FolderNode {
  return { id, name, depth, parentId, path: `${ACCOUNT_NAME} / ${path}` };
}

/** Depth-first, as gatherFolders returns it. */
export const FOLDERS: FolderNode[] = [
  node('f-clients', 'Clients', 1, null, 'Clients'),
  node('f-2025', '2025', 2, 'f-clients', 'Clients / 2025'),
  node('f-spring', 'Spring Launch', 3, 'f-2025', 'Clients / 2025 / Spring Launch'),
  node('f-creative', 'Creative', 4, 'f-spring', 'Clients / 2025 / Spring Launch / Creative'),
  node(
    'f-round1',
    'Round 1',
    5,
    'f-creative',
    'Clients / 2025 / Spring Launch / Creative / Round 1',
  ),
  node(
    'f-exports',
    'Exports',
    6,
    'f-round1',
    'Clients / 2025 / Spring Launch / Creative / Round 1 / Exports',
  ),
  node('f-holiday', 'Holiday Push', 3, 'f-2025', 'Clients / 2025 / Holiday Push'),
  node('f-decks', 'Decks', 4, 'f-holiday', 'Clients / 2025 / Holiday Push / Decks'),
  node('f-archive', 'Archive', 2, 'f-clients', 'Clients / Archive'),
  node('f-oldpitch', 'Old Pitch', 3, 'f-archive', 'Clients / Archive / Old Pitch'),
  node('f-assets', 'Assets', 4, 'f-oldpitch', 'Clients / Archive / Old Pitch / Assets'),
  node('f-deepa', 'Deep A', 5, 'f-assets', 'Clients / Archive / Old Pitch / Assets / Deep A'),
  node(
    'f-deepb',
    'Deep B',
    6,
    'f-deepa',
    'Clients / Archive / Old Pitch / Assets / Deep A / Deep B',
  ),
  node(
    'f-legacy',
    'Legacy',
    7,
    'f-deepb',
    'Clients / Archive / Old Pitch / Assets / Deep A / Deep B / Legacy',
  ),
  node(
    'f-files',
    'Files',
    8,
    'f-legacy',
    'Clients / Archive / Old Pitch / Assets / Deep A / Deep B / Legacy / Files',
  ),
  node(
    'f-spare',
    'Spare',
    7,
    'f-deepb',
    'Clients / Archive / Old Pitch / Assets / Deep A / Deep B / Spare',
  ),
  node('f-brand', 'Brand', 1, null, 'Brand'),
  node('f-logos', 'Logos', 2, 'f-brand', 'Brand / Logos'),
];

export const ANCHORS: ExistingCampaignAnchor[] = [
  { id: 'camp-spring', name: 'Spring Launch', driveFolderId: 'f-spring' },
  { id: 'camp-legacy', name: 'Legacy', driveFolderId: 'f-legacy' },
];
