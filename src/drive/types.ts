/**
 * drive/types.ts — Internal types for the Drive sync module.
 */

import type { drive_v3 } from 'googleapis';

export type DriveFile = drive_v3.Schema$File;

/**
 * Minimum fields we need off every file in a traversal.
 * Kept narrow so the caller can't accidentally depend on fields that might
 * be absent in a particular query.
 */
export interface TraversedFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  /** Full breadcrumb path computed during traversal, e.g. "Acme / Q3 Launch / Status". */
  path: string;
  modifiedTime: string | null;
  modifiedByEmail: string | null;
  /**
   * When the file was first created in Drive. Used by backfill to sort
   * files oldest-first so we can sample the earliest activity without
   * walking every revision. Nullable for back-compat with code paths
   * that don't request the field.
   */
  createdTime: string | null;
  size: number | null;
  /** True when this file is itself a folder (children were walked). */
  isFolder: boolean;
  /**
   * For files with mimeType='application/vnd.google-apps.shortcut':
   * the target the shortcut points to. The extractor follows this
   * (single-level) to extract from the actual file. Null for non-
   * shortcut files. Cross-drive targets are followed too — we want
   * greedy coverage of content that's only reachable via shortcut.
   */
  shortcutTarget?: { id: string; mimeType: string };
}

export interface ExtractionResult {
  text: string;
  contentHash: string;
  extractor: string;
}

export interface ExtractionSkip {
  kind: 'skip';
  reason:
    | 'folder'
    | 'unsupported_mime'
    | 'too_large'
    /** Shortcut to a binary mime (PDF/DOCX/PPTX/text/*) where the target's
     *  size isn't available from the shortcut metadata. Default-skip rather
     *  than download blindly — Drive's shortcutDetails fields don't include
     *  size, and downloading a multi-hundred-MB binary just to discover
     *  it exceeds the cap is the OOM vector we're guarding. */
    | 'shortcut_unverified_size'
    | 'empty'
    | 'delta_unchanged';
  detail?: string;
}

export type ExtractionOutcome = ({ kind: 'ok' } & ExtractionResult) | ExtractionSkip;

export interface TraversalScope {
  accountId: string | null;
  campaignId: string | null;
}
