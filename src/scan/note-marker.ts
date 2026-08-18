// Part of the scan core (src/scan/) — the format contract for the marker
// that partitions the shared account note card. Deliberately free of
// config/prisma imports so the unit suite can pin the format without an
// environment (CI is hermetic; src/config.ts throws at import time when
// DATABASE_URL is absent).
//
// New candidates have no DB row, so their items ride the ACCOUNT card,
// labelled with this marker. That makes one card key hold several distinct
// pending rows at once — the account's own notes, plus one row per candidate
// — and the marker is the only thing separating them.
//
// It is therefore load-bearing in BOTH directions, which is why it lives in
// one module rather than at each site: proposeTarget writes it, and the
// scan's already-on-record collection reads it to partition the card (an
// account target must not be told a candidate's facts, and a candidate must
// not be told a sibling's). Two separate definitions would drift and the
// partition would fail silently — no error, just suppression quietly
// matching nothing.
//
// Exact string matching here is on a prefix WE write in a format we control.
// It is never a similarity test on model prose — judging whether two facts
// mean the same thing is the distillation prompt's job.

export function newCandidateMarker(entityName: string): string {
  return `[new campaign candidate "${entityName}"]`;
}

/** True when a note item text carries ANY candidate marker. */
export function hasNewCandidateMarker(text: string): boolean {
  return /^\[new campaign candidate "/.test(text);
}

/**
 * Strip `entityName`'s marker off a note text, or null when the text isn't
 * marked for that candidate.
 */
export function stripNewCandidateMarker(text: string, entityName: string): string | null {
  const prefix = `${newCandidateMarker(entityName)} `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : null;
}
