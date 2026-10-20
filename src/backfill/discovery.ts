// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import {
  isListingUnavailableError,
  listingFailureCause,
  listSharedDriveFiles,
  probeFolder,
} from '../drive/client';
import { listSubtreeFiles } from '../drive/subtree';
import { traverseFolder } from '../drive/traversal';
import { log } from '../scan/output';
import type { TraversedFile } from '../drive/types';

// ── Phase 1: gather all files ───────────────────────────────────────────────

export async function gatherFilesAuto(
  folderId: string,
  label: string,
  newestFirst: boolean,
): Promise<TraversedFile[]> {
  const probe = await probeFolder(folderId);
  if (probe.isSharedDriveRoot && probe.driveId) {
    log(`  Folder type: shared drive root (driveId=${probe.driveId})`);
    log(`  Using FLAT list (orderBy=createdTime ${newestFirst ? 'desc' : 'asc'})…`);
    return listSharedDriveFiles(probe.driveId, {
      orderBy: newestFirst ? 'createdTime desc' : 'createdTime asc',
    });
  }
  log(`  Folder type: folder inside drive (driveId=${probe.driveId ?? 'My Drive'})`);
  if (probe.driveId) {
    // A folder inside a shared drive: list the drive flat and cut this
    // folder's subtree out, instead of one files.list per folder. Paths
    // match the recursive walk's. A refused drive listing (the bot can hold
    // a folder share without drive membership) falls back to the walk.
    log('  Using FLAT list of the drive, cut to this folder…');
    try {
      const { files, depthCapHits } = await listSubtreeFiles(folderId, label, probe.driveId);
      if (depthCapHits > 0)
        log(`  ⚠ ${depthCapHits} subfolder(s) past depth cap — files beneath NOT listed`);
      return sortByCreatedTime(files, newestFirst);
    } catch (err) {
      if (!isListingUnavailableError(err)) throw err;
      log(
        `  ⚠ flat listing unavailable (${listingFailureCause(err)}) — falling back to the recursive walk`,
      );
    }
  }
  log('  Using RECURSIVE walk…');
  return gatherFilesRecursive(folderId, label, newestFirst);
}

export async function gatherFilesRecursive(
  folderId: string,
  label: string,
  newestFirst: boolean,
): Promise<TraversedFile[]> {
  const files: TraversedFile[] = [];
  let folderCount = 0;
  let subfolderErrors = 0;
  let depthCapHits = 0;
  let lastTick = Date.now();
  let lastPath = '';
  const isTTY = process.stdout.isTTY === true;
  const tick = (): void => {
    if (!isTTY) return;
    const now = Date.now();
    if (now - lastTick < 250) return;
    lastTick = now;
    const pathTail = lastPath.length > 40 ? '…' + lastPath.slice(-40) : lastPath;
    const line = `  Listing files…  ${files.length} files, ${folderCount} folders   ${pathTail}`;
    process.stdout.write('\r' + line.padEnd(100).slice(0, 100));
  };
  for await (const f of traverseFolder(folderId, label, {
    onFolderError: () => {
      subfolderErrors++;
    },
    onDepthCap: () => {
      depthCapHits++;
    },
  })) {
    if (f.isFolder) {
      folderCount++;
      lastPath = f.path;
    } else {
      files.push(f);
    }
    tick();
  }
  if (isTTY) process.stdout.write('\r' + ' '.repeat(100) + '\r');
  if (subfolderErrors > 0) log(`  ⚠ ${subfolderErrors} subfolder(s) unreadable (skipped)`);
  if (depthCapHits > 0)
    log(`  ⚠ ${depthCapHits} subfolder(s) past depth cap — files beneath NOT listed`);
  return sortByCreatedTime(files, newestFirst);
}

/** In place, by createdTime (missing = epoch); stable, so ties keep listing order. */
function sortByCreatedTime(files: TraversedFile[], newestFirst: boolean): TraversedFile[] {
  files.sort((a, b) => {
    const at = a.createdTime ? new Date(a.createdTime).getTime() : 0;
    const bt = b.createdTime ? new Date(b.createdTime).getTime() : 0;
    return newestFirst ? bt - at : at - bt;
  });
  return files;
}
