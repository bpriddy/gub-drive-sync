/**
 * image-mimes.ts — which image/* mimes the vision path accepts (issue C2 / #35).
 *
 * Deliberately an ALLOW-LIST, not `startsWith('image/')`: Gemini inline
 * image understanding accepts exactly PNG / JPEG / WEBP / HEIC / HEIF.
 * Everything else under image/* (SVG, GIF, TIFF, BMP, PSD-as-image…) would
 * be a guaranteed API error, so those keep skipping as unsupported_mime —
 * same as before C2.
 *
 * Kept dependency-free so the scan planner and its hermetic unit tests can
 * import it without pulling the LLM driver (and its prisma-importing preset
 * service) into the unit suite.
 */

const VISION_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/** True when this mime is an image the Gemini vision path can ingest inline. */
export function isVisionEligibleImageMime(mimeType: string): boolean {
  return VISION_IMAGE_MIMES.has(mimeType);
}
