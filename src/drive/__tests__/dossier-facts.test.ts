import { describe, expect, it } from 'vitest';
import {
  dossierFacts,
  dossierSourceId,
  extractSrcMarkers,
  splitDossierBullets,
} from '../dossier-facts';

const AS_OF = '2026-08-28';
const GENERAL = 'status_markdown:campaign:camp_1';
const SENSITIVE = 'status_sensitive_markdown:campaign:camp_1';

/** The shape assembleStatusMarkdown produces (header + sections). */
const FULL_DOSSIER = [
  '_edited_at: 2026-08-20_',
  '',
  '## At a glance',
  '- Status: live',
  '- Budget: $200,000.00',
  '',
  '## Context',
  '- The campaign creative concept is titled "Drive Further". [src: 1abc]',
  '- Production is handled by the internal studio team. [src: 1def]',
  '',
  '## Transient',
  '- Shoot window planned for late September. [expires: 2026-10-01] [src: 1ghi]',
  '- Print deadline was last Friday. [expires: 2026-08-20] [src: 1jkl]',
  '',
].join('\n');

describe('splitDossierBullets', () => {
  it('splits bullet lines, stripping markers and whitespace', () => {
    expect(splitDossierBullets('- one fact\n-  another fact  \n- third')).toEqual([
      'one fact',
      'another fact',
      'third',
    ]);
  });

  it('treats prose lines (no bullet marker) as one fact per line', () => {
    expect(splitDossierBullets('First paragraph of prose.\n\nSecond paragraph.')).toEqual([
      'First paragraph of prose.',
      'Second paragraph.',
    ]);
  });

  it('handles nested bullets and CRLF endings', () => {
    expect(splitDossierBullets('- top\r\n  - nested detail')).toEqual(['top', 'nested detail']);
  });

  it('drops blank lines and sub-minimum debris', () => {
    expect(splitDossierBullets('- ok fact\n-\n- …\n   \n- x')).toEqual(['ok fact']);
  });

  it('returns [] for null/empty bodies', () => {
    expect(splitDossierBullets(null)).toEqual([]);
    expect(splitDossierBullets('')).toEqual([]);
  });
});

describe('extractSrcMarkers', () => {
  it('hoists the trailing [src: ...] citation and strips it from the text', () => {
    expect(extractSrcMarkers('CMO escalated over a budget overrun. [src: 1abc]')).toEqual({
      text: 'CMO escalated over a budget overrun.',
      fileIds: ['1abc'],
    });
  });

  it('collects multiple markers and comma/space-separated ids, deduped', () => {
    expect(extractSrcMarkers('Merged fact from two files. [src: 1abc, 1def] [src: 1abc]')).toEqual({
      text: 'Merged fact from two files.',
      fileIds: ['1abc', '1def'],
    });
  });

  it('keeps [expires: ...] markers in the text', () => {
    expect(
      extractSrcMarkers('Kat polishing the fun fact. [expires: 2026-06-11] [src: 1abc]'),
    ).toEqual({ text: 'Kat polishing the fun fact. [expires: 2026-06-11]', fileIds: ['1abc'] });
  });

  it('returns the line untouched when no marker is present', () => {
    expect(extractSrcMarkers('Plain prose fact.')).toEqual({
      text: 'Plain prose fact.',
      fileIds: [],
    });
  });
});

describe('dossierSourceId', () => {
  it('encodes tier, entity type and id', () => {
    expect(dossierSourceId('status_markdown', 'account', 'a1')).toBe('status_markdown:account:a1');
    expect(dossierSourceId('status_sensitive_markdown', 'campaign', 'c1')).toBe(
      'status_sensitive_markdown:campaign:c1',
    );
  });
});

describe('dossierFacts', () => {
  it('extracts Context and surviving Transient bullets with [src] provenance, never At a glance', () => {
    const facts = dossierFacts({
      statusMarkdown: FULL_DOSSIER,
      statusSensitiveMarkdown: null,
      asOfDate: AS_OF,
      generalSourceId: GENERAL,
      sensitiveSourceId: SENSITIVE,
    });
    expect(facts).toEqual([
      {
        text: 'The campaign creative concept is titled "Drive Further".',
        source_file_ids: ['1abc'],
      },
      {
        text: 'Production is handled by the internal studio team.',
        source_file_ids: ['1def'],
      },
      {
        text: 'Shoot window planned for late September. [expires: 2026-10-01]',
        source_file_ids: ['1ghi'],
      },
    ]);
  });

  it('drops transient bullets expired before the as-of date', () => {
    const facts = dossierFacts({
      statusMarkdown: FULL_DOSSIER,
      statusSensitiveMarkdown: null,
      asOfDate: '2026-11-01',
      generalSourceId: GENERAL,
      sensitiveSourceId: SENSITIVE,
    });
    expect(facts.map((f) => f.text)).toEqual([
      'The campaign creative concept is titled "Drive Further".',
      'Production is handled by the internal studio team.',
    ]);
  });

  it('keeps transient bullets without an expires marker (pruner posture)', () => {
    const facts = dossierFacts({
      statusMarkdown: '## Transient\n- No marker on this one. [src: 1abc]',
      statusSensitiveMarkdown: null,
      asOfDate: AS_OF,
      generalSourceId: GENERAL,
      sensitiveSourceId: SENSITIVE,
    });
    expect(facts.map((f) => f.text)).toEqual(['No marker on this one.']);
  });

  it('falls back to the tier sentinel for bullets without a [src] citation', () => {
    const facts = dossierFacts({
      statusMarkdown: '## Context\n- Prose-era fact without citation.',
      statusSensitiveMarkdown: '## Context\n- Sensitive budget detail.',
      asOfDate: AS_OF,
      generalSourceId: GENERAL,
      sensitiveSourceId: SENSITIVE,
    });
    expect(facts).toEqual([
      { text: 'Prose-era fact without citation.', source_file_ids: [GENERAL] },
      { text: 'Sensitive budget detail.', source_file_ids: [SENSITIVE] },
    ]);
  });

  it('dedupes identical texts across sections and tiers, first (general) wins', () => {
    const facts = dossierFacts({
      statusMarkdown:
        '## Context\n- Shared fact. [src: 1abc]\n\n## Transient\n- Shared fact. [src: 1def]',
      statusSensitiveMarkdown: '## Context\n- Shared fact.\n- Only sensitive.',
      asOfDate: AS_OF,
      generalSourceId: GENERAL,
      sensitiveSourceId: SENSITIVE,
    });
    expect(facts).toEqual([
      { text: 'Shared fact.', source_file_ids: ['1abc'] },
      { text: 'Only sensitive.', source_file_ids: [SENSITIVE] },
    ]);
  });

  it('drops bullets whose text is only a citation', () => {
    const facts = dossierFacts({
      statusMarkdown: '## Context\n- [src: 1abc]\n- Real fact. [src: 1def]',
      statusSensitiveMarkdown: null,
      asOfDate: AS_OF,
      generalSourceId: GENERAL,
      sensitiveSourceId: SENSITIVE,
    });
    expect(facts.map((f) => f.text)).toEqual(['Real fact.']);
  });

  it('returns [] for null dossiers and dossiers without Context/Transient', () => {
    expect(
      dossierFacts({
        statusMarkdown: null,
        statusSensitiveMarkdown: null,
        asOfDate: AS_OF,
        generalSourceId: GENERAL,
        sensitiveSourceId: SENSITIVE,
      }),
    ).toEqual([]);
    expect(
      dossierFacts({
        statusMarkdown: '_edited_at: 2026-08-20_\n\n## At a glance\n- Status: live\n',
        statusSensitiveMarkdown: null,
        asOfDate: AS_OF,
        generalSourceId: GENERAL,
        sensitiveSourceId: SENSITIVE,
      }),
    ).toEqual([]);
  });
});
