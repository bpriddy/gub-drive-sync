/** GEMINI_THINKING_BY_TAG: parsing, and which level a call tag gets. */
import { describe, expect, it } from 'vitest';
import { callTypeOf, parseThinkingMap, thinkingLevelFor } from '../thinking';

describe('parseThinkingMap', () => {
  it('reads a JSON object of levels; the default "{}" is empty', () => {
    expect(parseThinkingMap('{}')).toEqual({});
    expect(parseThinkingMap('{"interpret":"LOW","drive.distillation.v1":"MINIMAL"}')).toEqual({
      interpret: 'LOW',
      'drive.distillation.v1': 'MINIMAL',
    });
  });

  it('rejects anything else, so a typo fails at startup', () => {
    expect(() => parseThinkingMap('interpret=LOW')).toThrow('must be a JSON object');
    expect(() => parseThinkingMap('["LOW"]')).toThrow('must be a JSON object');
    expect(() => parseThinkingMap('null')).toThrow('must be a JSON object');
    expect(() => parseThinkingMap('{"interpret":"low"}')).toThrow('interpret must be one of');
    expect(() => parseThinkingMap('{"interpret":0}')).toThrow('interpret must be one of');
    expect(() => parseThinkingMap('{"interpert":"LOW"}')).toThrow(
      'interpert is not a call type or a known call tag',
    );
    expect(() => parseThinkingMap('{"unit.test":"LOW"}')).toThrow('is not a call type');
  });
});

describe('thinkingLevelFor', () => {
  it('sends nothing when the map is empty or the tag is unmapped', () => {
    expect(thinkingLevelFor('drive.file_extraction.v1', {})).toBeUndefined();
    expect(thinkingLevelFor('drive.file_extraction.v1', { distill: 'LOW' })).toBeUndefined();
    expect(thinkingLevelFor(undefined, { interpret: 'LOW' })).toBeUndefined();
  });

  it('maps a tag by its call-type name, whatever the version', () => {
    expect(thinkingLevelFor('drive.file_extraction.v1', { interpret: 'LOW' })).toBe('LOW');
    expect(thinkingLevelFor('drive.file_extraction.v2', { interpret: 'LOW' })).toBe('LOW');
    expect(thinkingLevelFor('backfill.status-synthesis-v1', { synthesis: 'LOW' })).toBe('LOW');
  });

  it('lets an entry for the exact tag win over its call-type name', () => {
    expect(
      thinkingLevelFor('drive.distillation.v1', {
        distill: 'LOW',
        'drive.distillation.v1': 'MEDIUM',
      }),
    ).toBe('MEDIUM');
  });

  it('names every call tag in the codebase', () => {
    for (const [tag, callType] of [
      ['drive.file_extraction.v1', 'interpret'],
      ['drive.distillation.v1', 'distill'],
      ['drive.structure_resolution.v1-inline', 'classify'],
      ['drive.idea_extraction.v1', 'idea_extract'],
      ['drive.idea_match_merge.v1', 'idea_merge'],
      ['backfill.status-synthesis-v1', 'synthesis'],
      ['campaign_merge.status-synthesis-v1', 'campaign_merge'],
      ['campaign_cluster_detection.v1', 'cluster'],
      ['drive.asset_folder.v1', 'asset_folder'],
      ['drive.piece_derive.v1', 'piece_derive'],
      ['drive.field_heal.v1', 'heal'],
      ['drive.new_entity_extraction.v1', 'discover'],
    ] as const) {
      expect(callTypeOf(tag)).toBe(callType);
    }
    expect(callTypeOf('unit.test')).toBeNull();
  });
});
