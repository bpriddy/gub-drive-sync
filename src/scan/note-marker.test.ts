import { describe, expect, it } from 'vitest';
import {
  hasNewCandidateMarker,
  newCandidateMarker,
  stripNewCandidateMarker,
} from './note-marker';

// The marker is what partitions the shared account card: the account's own
// notes plus one pending row per new candidate all live under one key, and
// only this label tells them apart. These tests pin the format so the writer
// and the already-on-record reader can't drift apart silently.
describe('new-candidate marker', () => {
  const marked = `${newCandidateMarker('Fall Equinox')} Maya is the creative lead`;

  it('round-trips: what proposeTarget writes, collectKnownFacts strips', () => {
    expect(stripNewCandidateMarker(marked, 'Fall Equinox')).toBe(
      'Maya is the creative lead',
    );
  });

  it("does not hand a candidate its sibling's facts", () => {
    expect(stripNewCandidateMarker(marked, 'Holiday Push')).toBeNull();
  });

  it('does not claim an unmarked account note', () => {
    expect(stripNewCandidateMarker('Maya is the creative lead', 'Fall Equinox')).toBeNull();
  });

  it('detects any candidate marker, so account targets can drop them all', () => {
    expect(hasNewCandidateMarker(marked)).toBe(true);
    expect(hasNewCandidateMarker(`${newCandidateMarker('Anything At All')} x`)).toBe(true);
    expect(hasNewCandidateMarker('Maya is the creative lead')).toBe(false);
    // Not a prefix — a mention mid-sentence must not count.
    expect(
      hasNewCandidateMarker('the brief says [new campaign candidate "X"] somewhere'),
    ).toBe(false);
  });
});
