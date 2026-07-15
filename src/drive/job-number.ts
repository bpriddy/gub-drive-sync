/**
 * job-number.ts — HARD piece-level identity (doctrine locked 2026-07-15).
 *
 * "Job numbers correlate to pieces. They are hard and authoritative."
 * Agency convention (verified across the Chevy drive, 16/16 unique):
 * project folders carry bracket codes — `02. Chevy | BHAC [GMCHV55000216]`,
 * `13. Chevy | BHAC AI + LMA Tool [GMCHV550002340]`. Each code identifies a
 * JOB (an execution = a piece); the meaning-level campaign groups jobs above
 * them. Same number = same piece, always; different numbers = different
 * pieces, always — job-number matching outranks all name/meaning matching.
 *
 * Structural extraction, same precedent as the year gate: a deterministic
 * token in a naming convention, not meaning-guessing.
 */

/** Bracketed job code: 2-10 uppercase letters + 4-14 digits, e.g. [GMCHV55000216]. */
export const JOB_NUMBER_PATTERN = /\[([A-Z]{2,10}\d{4,14})\]/;

/** Extract the job number from a folder/campaign/piece name, or null. */
export function extractJobNumber(name: string): string | null {
  const m = name.match(JOB_NUMBER_PATTERN);
  return m ? m[1]! : null;
}
