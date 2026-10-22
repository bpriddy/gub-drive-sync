/**
 * classify-prompt-size.ts — offline size of the folder classify prompt (#69).
 *
 * Builds a synthetic folder tree with the depth profile of today's largest
 * account tree, at several scales, and renders the classify prompt whole
 * (CLASSIFY_DEPTH_CAP_MODE=off) and capped (auto). Prints characters and an
 * estimated token count (CLASSIFY_TOKENS_PER_FOLDER per folder shown).
 *
 * Calls nothing: no Drive, no database, no model. DATABASE_URL only has to
 * satisfy config validation.
 *
 * Usage:
 *   DATABASE_URL=unused npm run classify-prompt-size -- [--scales 1,4,10]
 */
import { createHash } from 'node:crypto';
import {
  buildPrompt,
  capFolderTree,
  CLASSIFY_INPUT_TOKEN_LIMIT,
  depthCapFor,
  estimateClassifyTokens,
  type ExistingCampaignAnchor,
  type FolderNode,
} from '../src/drive/structure';

/**
 * Folders per depth in the largest account tree (2026-10, 6,543 folders;
 * depth 1 = the account root's children). Its campaign roots and anchors
 * sit at depth 3 and 4. Mean folder name: about 14 characters.
 */
const DEPTH_PROFILE = [9, 76, 164, 473, 1618, 1355, 1158, 772, 395, 295, 113, 51, 37, 11, 16];
const ANCHORS_AT_DEPTH: Record<number, number> = { 3: 43, 4: 4 };
export const DEFAULT_DEPTH_CAP = 5;

/** A Drive-like 33-character folder id. */
export function syntheticId(n: number): string {
  return '1' + createHash('sha256').update(`folder-${n}`).digest('base64url').slice(0, 32);
}

export function syntheticTree(scale: number): {
  folders: FolderNode[];
  anchors: ExistingCampaignAnchor[];
} {
  // Level by level, each folder under a round-robin parent one level up.
  const childrenOf = new Map<string | null, FolderNode[]>();
  const anchors: ExistingCampaignAnchor[] = [];
  let previous: FolderNode[] = [];
  let n = 0;
  DEPTH_PROFILE.forEach((count, i) => {
    const depth = i + 1;
    const level: FolderNode[] = [];
    for (let j = 0; j < count * scale; j++) {
      const parent = depth === 1 ? null : previous[j % previous.length]!;
      const name = `Folder ${depth}-${String(j).padStart(5, '0')}`;
      const f: FolderNode = {
        id: syntheticId(n++),
        name,
        path: `${parent?.path ?? 'Account'} / ${name}`,
        depth,
        parentId: parent?.id ?? null,
      };
      level.push(f);
      const siblings = childrenOf.get(f.parentId);
      if (siblings) siblings.push(f);
      else childrenOf.set(f.parentId, [f]);
      if (j < (ANCHORS_AT_DEPTH[depth] ?? 0) * scale) {
        anchors.push({
          id: createHash('sha256').update(`campaign-${n}`).digest('hex').slice(0, 36),
          name,
          driveFolderId: f.id,
        });
      }
    }
    previous = level;
  });

  // gatherFolders order: depth-first.
  const folders: FolderNode[] = [];
  const visit = (parentId: string | null): void => {
    for (const f of childrenOf.get(parentId) ?? []) {
      folders.push(f);
      visit(f.id);
    }
  };
  visit(null);
  return { folders, anchors };
}

function parseScales(argv: string[]): number[] {
  const i = argv.indexOf('--scales');
  const raw = i >= 0 ? argv[i + 1] : undefined;
  const scales = (raw ?? '1,4,10').split(',').map(Number);
  if (scales.some((s) => !Number.isInteger(s) || s < 1)) {
    console.error('classify-prompt-size: --scales takes positive integers, e.g. 1,4,10');
    process.exit(2);
  }
  return scales;
}

const pct = (tokens: number) => `${((tokens / CLASSIFY_INPUT_TOKEN_LIMIT) * 100).toFixed(0)}%`;

function main(): void {
  const rows: Array<Record<string, string | number>> = [];
  for (const scale of parseScales(process.argv.slice(2))) {
    const { folders, anchors } = syntheticTree(scale);
    const prompt = (shown: FolderNode[], hiddenBelow?: Map<string, number>) =>
      buildPrompt({
        accountName: 'Account',
        rootFolderId: syntheticId(-1),
        folders: shown,
        anchors,
        hiddenBelow,
      });

    const whole = prompt(folders);
    // The previous classification: every anchor is a campaign root.
    const cap = depthCapFor(
      folders,
      anchors.map((a) => ({ folderId: a.driveFolderId, classification: 'existing_campaign' })),
      anchors.map((a) => a.driveFolderId),
      DEFAULT_DEPTH_CAP,
    );
    const capped = capFolderTree(
      folders,
      cap,
      anchors.map((a) => a.driveFolderId),
    );
    const cappedPrompt = prompt(capped.folders, capped.hiddenBelow);

    rows.push({
      scale: `${scale}x`,
      folders: folders.length,
      'whole chars': whole.length,
      'whole est. tokens': estimateClassifyTokens(folders.length),
      'whole of limit': pct(estimateClassifyTokens(folders.length)),
      cap,
      'capped folders': capped.folders.length,
      'capped chars': cappedPrompt.length,
      'capped est. tokens': estimateClassifyTokens(capped.folders.length),
      'capped of limit': pct(estimateClassifyTokens(capped.folders.length)),
    });
  }
  console.table(rows);
  console.log(
    `Estimate: ${estimateClassifyTokens(1)} tokens per folder shown; input limit ${CLASSIFY_INPUT_TOKEN_LIMIT.toLocaleString('en-US')} tokens.`,
  );
}

if (require.main === module) main();
