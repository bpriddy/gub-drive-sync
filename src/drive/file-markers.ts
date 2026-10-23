/**
 * file-markers.ts — Drive's content markers on a TraversedFile.
 *
 * Kept apart from drive/client.ts so the discovery paths that build a
 * TraversedFile can share it without loading the Drive client.
 */
import type { drive_v3 } from 'googleapis';
import type { TraversedFile } from './types';

/**
 * The content markers fileFields() requests, keeping only the fields Drive
 * returned. The unchanged-content gate (src/scan/content-gate.ts) reads them.
 */
export function contentMarkers(
  f: drive_v3.Schema$File,
): Pick<TraversedFile, 'version' | 'md5Checksum' | 'headRevisionId' | 'trashed'> {
  return {
    ...(f.version ? { version: f.version } : {}),
    ...(f.md5Checksum ? { md5Checksum: f.md5Checksum } : {}),
    ...(f.headRevisionId ? { headRevisionId: f.headRevisionId } : {}),
    ...(typeof f.trashed === 'boolean' ? { trashed: f.trashed } : {}),
  };
}
