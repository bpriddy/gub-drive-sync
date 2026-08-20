/**
 * image-vision-plan.ts — deterministic scope/cap allocation for image
 * vision extraction (issue C2 / #35).
 *
 * The scan worker pool runs files in scheduler-dependent order, but which
 * images win a vision slot must not depend on scheduling — so the whole
 * batch's image gate decisions are computed HERE, in batch (file-index)
 * order, before the pool starts. Three free gates, cheapest exclusion
 * first:
 *
 *   1. Scope   — only images inside a folder-backed piece folder qualify
 *                (the whole "piece folders first" narrowing). Content-born
 *                pieces have no Drive folder → no files → invisible; an
 *                accepted limitation of this phase.
 *   2. Floor   — the metadata relevance gate: tiny files are chrome
 *                (icons, favicons, logo cuts), not deliverables.
 *   3. Caps    — per-piece and per-batch count caps bound the spend.
 *
 * Denied files carry a skipDetail that extract.ts threads into their
 * out_of_scope_image skip. Pure module (no config/prisma imports) so the
 * unit suite stays hermetic — caps come in as an argument.
 */

import { isVisionEligibleImageMime } from '../drive/image-mimes';
import type { TraversedFile } from '../drive/types';

export interface ImageVisionGate {
  /** Piece scope resolved for this file; null = outside any folder-backed piece. */
  pieceId: string | null;
  /** The worker's verdict, passed to extractText as opts.allowImageVision. */
  allowImageVision: boolean;
  /** Why the gate denied vision — becomes the out_of_scope_image skip detail. */
  skipDetail?: string;
}

export interface ImageVisionCaps {
  /** Relevance floor: images smaller than this are chrome, not deliverables. */
  minFileSizeBytes: number;
  /** Inline-request byte cap (base64 inflation is why it's 14 MB, not 20). */
  maxFileSizeBytes: number;
  /** Vision-call cap per piece within this batch. */
  maxPerPiece: number;
  /** Vision-call cap across the whole batch. */
  maxPerBatch: number;
}

/** Detail token for images with no piece scope (the scope gate). */
export const NO_PIECE_SCOPE = 'no_piece_scope';

/**
 * Compute the image-vision gate for every vision-eligible image in the
 * batch, keyed by file id. Files absent from the map are not images the
 * vision path could ever take (folders, other mimes, image mimes the API
 * rejects) and need no opts at all.
 */
export function planImageVision(
  batch: TraversedFile[],
  resolvePieceId: (file: TraversedFile) => string | null,
  caps: ImageVisionCaps,
): Map<string, ImageVisionGate> {
  const plan = new Map<string, ImageVisionGate>();
  const perPieceGranted = new Map<string, number>();
  let batchGranted = 0;

  for (const file of batch) {
    if (file.isFolder || !isVisionEligibleImageMime(file.mimeType)) continue;

    const pieceId = resolvePieceId(file);
    if (!pieceId) {
      plan.set(file.id, { pieceId: null, allowImageVision: false, skipDetail: NO_PIECE_SCOPE });
      continue;
    }
    // Unknown size (null) passes both size gates here — extract.ts
    // re-checks the byte cap on the actually-downloaded buffer.
    if (file.size != null && file.size < caps.minFileSizeBytes) {
      plan.set(file.id, {
        pieceId,
        allowImageVision: false,
        skipDetail: `below_min_size size=${file.size} floor=${caps.minFileSizeBytes}`,
      });
      continue;
    }
    if (file.size != null && file.size > caps.maxFileSizeBytes) {
      plan.set(file.id, {
        pieceId,
        allowImageVision: false,
        skipDetail: `over_size_cap size=${file.size} limit=${caps.maxFileSizeBytes}`,
      });
      continue;
    }
    if ((perPieceGranted.get(pieceId) ?? 0) >= caps.maxPerPiece) {
      plan.set(file.id, { pieceId, allowImageVision: false, skipDetail: 'per_piece_cap' });
      continue;
    }
    if (batchGranted >= caps.maxPerBatch) {
      plan.set(file.id, { pieceId, allowImageVision: false, skipDetail: 'per_batch_cap' });
      continue;
    }

    perPieceGranted.set(pieceId, (perPieceGranted.get(pieceId) ?? 0) + 1);
    batchGranted += 1;
    plan.set(file.id, { pieceId, allowImageVision: true });
  }

  return plan;
}
