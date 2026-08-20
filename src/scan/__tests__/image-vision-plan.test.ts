/**
 * Unit tests for the image-vision scope/cap planner (issue C2 / #35).
 *
 * The planner is the worker-side half of the image gate: extract.ts only
 * honors its verdict, so the scope narrowing, the relevance floor, and the
 * per-piece/per-batch cap allocation are pinned HERE. Pure module — no
 * config, prisma, or LLM driver — so the suite stays hermetic.
 */

import { describe, it, expect } from 'vitest';
import { planImageVision, NO_PIECE_SCOPE } from '../image-vision-plan';
import type { TraversedFile } from '../../drive/types';

const CAPS = {
  minFileSizeBytes: 10_240,
  maxFileSizeBytes: 14_680_064,
  maxPerPiece: 2,
  maxPerBatch: 3,
};

function file(id: string, overrides: Partial<TraversedFile> = {}): TraversedFile {
  return {
    id,
    name: `${id}.png`,
    mimeType: 'image/png',
    path: `Acme / C1 / P1 / ${id}.png`,
    modifiedTime: null,
    modifiedByEmail: null,
    createdTime: null,
    size: 50_000,
    isFolder: false,
    ...overrides,
  };
}

/** resolvePieceId stub: piece scope comes from the file's pieceId tag. */
const byTag = (f: TraversedFile): string | null => f.pieceId ?? null;

describe('planImageVision', () => {
  it('grants vision to an in-scope image and records its piece', () => {
    const plan = planImageVision([file('a', { pieceId: 'p1' })], byTag, CAPS);
    expect(plan.get('a')).toEqual({ pieceId: 'p1', allowImageVision: true });
  });

  it('plans only vision-eligible images — folders, other mimes, and API-rejected image mimes get no entry', () => {
    const plan = planImageVision(
      [
        file('folder', { isFolder: true, mimeType: 'application/vnd.google-apps.folder' }),
        file('pdf', { mimeType: 'application/pdf', pieceId: 'p1' }),
        file('svg', { mimeType: 'image/svg+xml', pieceId: 'p1' }),
        file('img', { pieceId: 'p1' }),
      ],
      byTag,
      CAPS,
    );
    expect([...plan.keys()]).toEqual(['img']);
  });

  it('scope gate: an image outside any piece folder is denied with no_piece_scope', () => {
    const plan = planImageVision([file('a')], byTag, CAPS);
    expect(plan.get('a')).toEqual({
      pieceId: null,
      allowImageVision: false,
      skipDetail: NO_PIECE_SCOPE,
    });
  });

  it('relevance floor: tiny images (chrome) are denied below_min_size', () => {
    const plan = planImageVision([file('a', { pieceId: 'p1', size: 512 })], byTag, CAPS);
    expect(plan.get('a')).toMatchObject({ allowImageVision: false });
    expect(plan.get('a')!.skipDetail).toMatch(/^below_min_size /);
  });

  it('size cap: oversized images are denied over_size_cap', () => {
    const plan = planImageVision([file('a', { pieceId: 'p1', size: 20_000_000 })], byTag, CAPS);
    expect(plan.get('a')).toMatchObject({ allowImageVision: false });
    expect(plan.get('a')!.skipDetail).toMatch(/^over_size_cap /);
  });

  it('unknown size passes both size gates (extract.ts re-checks the real bytes)', () => {
    const plan = planImageVision([file('a', { pieceId: 'p1', size: null })], byTag, CAPS);
    expect(plan.get('a')).toEqual({ pieceId: 'p1', allowImageVision: true });
  });

  it('per-piece cap: allocation is deterministic in batch order, excess denied per_piece_cap', () => {
    const plan = planImageVision(
      [file('a', { pieceId: 'p1' }), file('b', { pieceId: 'p1' }), file('c', { pieceId: 'p1' })],
      byTag,
      CAPS,
    );
    expect(plan.get('a')!.allowImageVision).toBe(true);
    expect(plan.get('b')!.allowImageVision).toBe(true);
    expect(plan.get('c')).toEqual({
      pieceId: 'p1',
      allowImageVision: false,
      skipDetail: 'per_piece_cap',
    });
  });

  it('per-piece cap slots are not burned by images other gates already denied', () => {
    const plan = planImageVision(
      [
        file('tiny', { pieceId: 'p1', size: 512 }),
        file('a', { pieceId: 'p1' }),
        file('b', { pieceId: 'p1' }),
      ],
      byTag,
      CAPS,
    );
    expect(plan.get('a')!.allowImageVision).toBe(true);
    expect(plan.get('b')!.allowImageVision).toBe(true);
  });

  it('per-batch cap: grants across pieces stop at the batch cap with per_batch_cap', () => {
    const plan = planImageVision(
      [
        file('a', { pieceId: 'p1' }),
        file('b', { pieceId: 'p1' }),
        file('c', { pieceId: 'p2' }),
        file('d', { pieceId: 'p2' }),
      ],
      byTag,
      CAPS,
    );
    expect(plan.get('c')!.allowImageVision).toBe(true);
    expect(plan.get('d')).toEqual({
      pieceId: 'p2',
      allowImageVision: false,
      skipDetail: 'per_batch_cap',
    });
  });
});
