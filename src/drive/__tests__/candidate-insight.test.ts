import { describe, expect, it, vi } from 'vitest';
import {
  CandidateInsightSchema,
  NOTE_DEFAULT_CONFIDENCE,
  toCandidateInsights,
  type CandidateDistillResult,
  type CandidateTarget,
} from '../candidate-insight';

const ACCOUNT_ID = 'acct_1';

const accountTarget: CandidateTarget = {
  accountId: ACCOUNT_ID,
  entityType: 'account',
  entityStatus: 'account',
  entityId: ACCOUNT_ID,
  campaignFolderId: null,
  entityName: 'Acme Corp',
};

const existingCampaignTarget: CandidateTarget = {
  accountId: ACCOUNT_ID,
  entityType: 'campaign',
  entityStatus: 'existing',
  entityId: 'camp_9',
  campaignFolderId: 'folder_camp_9',
  entityName: 'Spring Launch',
};

const newCampaignTarget: CandidateTarget = {
  accountId: ACCOUNT_ID,
  entityType: 'campaign',
  entityStatus: 'new',
  entityId: null,
  campaignFolderId: 'folder_new_1',
  entityName: 'Fall Teaser',
};

const emptyDistill: CandidateDistillResult = { field_changes: [], notes: [] };

const oneOfEach: CandidateDistillResult = {
  field_changes: [
    {
      field: 'budget',
      proposed_value: '50000',
      reasoning: 'stated in the brief',
      source_file_ids: ['file_a', 'file_b'],
      confidence: 0.85,
    },
  ],
  notes: [{ text: 'Client wants a June launch.', source_file_ids: ['file_c'] }],
};

describe('toCandidateInsights — mapping', () => {
  it('maps a field_change to a candidate with rendered text and its own confidence', () => {
    const [candidate] = toCandidateInsights(existingCampaignTarget, {
      ...emptyDistill,
      field_changes: oneOfEach.field_changes,
    });
    expect(candidate).toEqual({
      accountId: ACCOUNT_ID,
      entityType: 'campaign',
      entityId: 'camp_9',
      entityStatus: 'existing',
      text: 'budget → 50000 (stated in the brief)',
      sourceFileIds: ['file_a', 'file_b'],
      confidence: 0.85,
      origin: 'field_change',
    });
  });

  it('renders a null proposed_value as (null)', () => {
    const [candidate] = toCandidateInsights(existingCampaignTarget, {
      ...emptyDistill,
      field_changes: [{ ...oneOfEach.field_changes[0]!, proposed_value: null }],
    });
    expect(candidate!.text).toBe('budget → (null) (stated in the brief)');
  });

  it('maps a note to a candidate with the default confidence', () => {
    const [candidate] = toCandidateInsights(existingCampaignTarget, {
      ...emptyDistill,
      notes: oneOfEach.notes,
    });
    expect(candidate).toEqual({
      accountId: ACCOUNT_ID,
      entityType: 'campaign',
      entityId: 'camp_9',
      entityStatus: 'existing',
      text: 'Client wants a June launch.',
      sourceFileIds: ['file_c'],
      confidence: NOTE_DEFAULT_CONFIDENCE,
      origin: 'note',
    });
  });

  it('emits field_changes and notes together, field_changes first', () => {
    const candidates = toCandidateInsights(existingCampaignTarget, oneOfEach);
    expect(candidates.map((c) => c.origin)).toEqual(['field_change', 'note']);
  });
});

describe('toCandidateInsights — scope from the Target', () => {
  it('account target: entityId is the account id, no entityStatus', () => {
    const [candidate] = toCandidateInsights(accountTarget, oneOfEach);
    expect(candidate!.entityType).toBe('account');
    expect(candidate!.entityId).toBe(ACCOUNT_ID);
    expect(candidate!.entityStatus).toBeUndefined();
    expect(candidate!.accountId).toBe(ACCOUNT_ID);
  });

  it('account target on a campaign-scoped scan (Target.entityId null) still anchors to accountId', () => {
    const [candidate] = toCandidateInsights({ ...accountTarget, entityId: null }, oneOfEach);
    expect(candidate!.entityId).toBe(ACCOUNT_ID);
  });

  it('existing campaign: entityId is the matched campaign id', () => {
    const [candidate] = toCandidateInsights(existingCampaignTarget, oneOfEach);
    expect(candidate!.entityType).toBe('campaign');
    expect(candidate!.entityStatus).toBe('existing');
    expect(candidate!.entityId).toBe('camp_9');
  });

  it('new campaign candidate: entityId is the campaign folder ref', () => {
    const [candidate] = toCandidateInsights(newCampaignTarget, oneOfEach);
    expect(candidate!.entityType).toBe('campaign');
    expect(candidate!.entityStatus).toBe('new');
    expect(candidate!.entityId).toBe('folder_new_1');
  });

  it('phantom new candidate (no folder id) emits nothing and warns', () => {
    const warn = vi.fn();
    const candidates = toCandidateInsights(
      { ...newCampaignTarget, campaignFolderId: null },
      oneOfEach,
      warn,
    );
    expect(candidates).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('phantom'));
  });

  it('piece target emits nothing (pieces are the idea-extraction tier)', () => {
    const candidates = toCandidateInsights(
      {
        accountId: ACCOUNT_ID,
        entityType: 'piece',
        entityStatus: 'piece',
        entityId: 'piece_1',
        campaignFolderId: null,
        entityName: 'Hero video',
      },
      oneOfEach,
    );
    expect(candidates).toEqual([]);
  });
});

describe('toCandidateInsights — provenance and validation (A1)', () => {
  it('drops a candidate with empty sourceFileIds and warns instead of emitting', () => {
    const warn = vi.fn();
    const candidates = toCandidateInsights(
      existingCampaignTarget,
      {
        field_changes: [{ ...oneOfEach.field_changes[0]!, source_file_ids: [] }],
        notes: oneOfEach.notes,
      },
      warn,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.origin).toBe('note');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('empty sourceFileIds'));
  });

  it('drops a note with empty text without throwing', () => {
    const warn = vi.fn();
    const candidates = toCandidateInsights(
      existingCampaignTarget,
      { ...emptyDistill, notes: [{ text: '', source_file_ids: ['file_c'] }] },
      warn,
    );
    expect(candidates).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('CandidateInsightSchema', () => {
  const valid = {
    accountId: ACCOUNT_ID,
    entityType: 'campaign',
    entityId: 'camp_9',
    entityStatus: 'existing',
    text: 'Client wants a June launch.',
    sourceFileIds: ['file_c'],
    confidence: 0.5,
    origin: 'note',
  };

  it('accepts a valid candidate', () => {
    expect(() => CandidateInsightSchema.parse(valid)).not.toThrow();
  });

  it('rejects empty text', () => {
    expect(() => CandidateInsightSchema.parse({ ...valid, text: '' })).toThrow();
  });

  it('rejects empty sourceFileIds', () => {
    expect(() => CandidateInsightSchema.parse({ ...valid, sourceFileIds: [] })).toThrow();
  });

  it('rejects out-of-range confidence', () => {
    expect(() => CandidateInsightSchema.parse({ ...valid, confidence: 1.2 })).toThrow();
    expect(() => CandidateInsightSchema.parse({ ...valid, confidence: -0.1 })).toThrow();
  });
});
