import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../prisma', () => ({
  prisma: {
    driveChangeProposal: {
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      create: mocks.create,
    },
  },
}));
vi.mock('../../config', () => ({ config: { DRIVE_PROPOSAL_TTL_DAYS: 7 } }));
vi.mock('../output', () => ({ log: vi.fn() }));

import { loadPendingNoteTexts, proposeTarget } from '../propose';
import type { ProposeTargetInput } from '../propose';
import type { ValidatedChange } from '../persist';
import type { EntityCtx } from '../batch-types';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeCtx(overrides: Partial<EntityCtx> = {}): EntityCtx {
  return {
    type: 'account',
    id: 'acct-1',
    name: 'Acme',
    folderId: 'folder-1',
    accountId: 'acct-1',
    accountFolderId: 'folder-root-1',
    accountName: 'Acme',
    campaignName: null,
    reviewerEmail: 'reviewer@example.com',
    reviewerStaffId: 'staff-1',
    ...overrides,
  } as EntityCtx;
}

function makeChange(overrides: Partial<ValidatedChange> = {}): ValidatedChange {
  return {
    field: 'budget',
    spec: {} as ValidatedChange['spec'],
    validatedValue: 5000,
    previousValue: 4000,
    proposedValueRaw: '5000',
    confidence: 0.8,
    reasoning: 'Kickoff deck states the new budget',
    sourceFileIds: ['file-1', 'file-2'],
    ...overrides,
  };
}

function makeInput(overrides: Partial<ProposeTargetInput> = {}): ProposeTargetInput {
  return {
    ctx: makeCtx(),
    entityType: 'campaign',
    entityStatus: 'existing',
    entityId: 'camp-1',
    entityName: 'Spring Launch',
    validatedChanges: [],
    notes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.findFirst.mockReset().mockResolvedValue(null);
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.create.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('proposeTarget: field_change rows', () => {
  it('writes one pending field_change row carrying provenance, reviewer and TTL expiry', async () => {
    const result = await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));

    expect(result).toEqual({ fieldProposals: 1, noteItems: 0, duplicatesSkipped: 0 });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      kind: 'field_change',
      entityType: 'campaign',
      accountId: 'acct-1',
      campaignId: 'camp-1',
      property: 'budget',
      currentValue: 4000,
      proposedValue: 5000,
      reasoning: 'Kickoff deck states the new budget',
      sourceFileIds: ['file-1', 'file-2'],
      state: 'pending',
      reviewerEmail: 'reviewer@example.com',
      reviewerStaffId: 'staff-1',
    });
    expect(data.confidence).toBeInstanceOf(Prisma.Decimal);
    expect(data.confidence.toString()).toBe('0.8');
    expect(data.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
    expect(data.reviewToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives every row its own review token', async () => {
    await proposeTarget(
      makeInput({
        validatedChanges: [makeChange({ field: 'budget' }), makeChange({ field: 'status' })],
      }),
    );
    const tokens = mocks.create.mock.calls.map((c) => c[0].data.reviewToken);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('targets the account for an account-level change (campaignId null, accountId = entityId)', async () => {
    await proposeTarget(
      makeInput({
        entityType: 'account',
        entityStatus: 'account',
        entityId: 'acct-9',
        validatedChanges: [makeChange({ field: 'industry', validatedValue: 'Retail' })],
      }),
    );
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      entityType: 'account',
      accountId: 'acct-9',
      campaignId: null,
      property: 'industry',
      proposedValue: 'Retail',
    });
  });

  it('writes JSON null for a null previous/proposed value', async () => {
    await proposeTarget(
      makeInput({
        validatedChanges: [makeChange({ previousValue: null, validatedValue: null })],
      }),
    );
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data.currentValue).toBe(Prisma.JsonNull);
    expect(data.proposedValue).toBe(Prisma.JsonNull);
  });

  it('stamps null reviewer fields when the ctx has no reviewer', async () => {
    await proposeTarget(
      makeInput({
        ctx: makeCtx({ reviewerEmail: null, reviewerStaffId: null }),
        validatedChanges: [makeChange()],
      }),
    );
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      reviewerEmail: null,
      reviewerStaffId: null,
    });
  });

  it('expiry follows DRIVE_PROPOSAL_TTL_DAYS from config', async () => {
    const { config } = await import('../../config');
    (config as { DRIVE_PROPOSAL_TTL_DAYS: number }).DRIVE_PROPOSAL_TTL_DAYS = 30;
    try {
      await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    } finally {
      (config as { DRIVE_PROPOSAL_TTL_DAYS: number }).DRIVE_PROPOSAL_TTL_DAYS = 7;
    }
    expect(mocks.create.mock.calls[0]![0].data.expiresAt).toEqual(
      new Date(NOW.getTime() + 30 * DAY_MS),
    );
  });
});

describe('proposeTarget: re-propose guard', () => {
  it('looks for a pending field_change on the same target and property', async () => {
    await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        kind: 'field_change',
        entityType: 'campaign',
        accountId: 'acct-1',
        campaignId: 'camp-1',
        property: 'budget',
        state: 'pending',
      },
      select: { id: true, proposedValue: true },
    });
  });

  it('skips a change whose value equals the pending proposal and counts it', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'prop-1', proposedValue: 5000 });
    const result = await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    expect(result).toEqual({ fieldProposals: 0, noteItems: 0, duplicatesSkipped: 1 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('compares structured values by content', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'prop-1', proposedValue: { a: 1, b: [2] } });
    const result = await proposeTarget(
      makeInput({ validatedChanges: [makeChange({ validatedValue: { a: 1, b: [2] } })] }),
    );
    expect(result.duplicatesSkipped).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('treats a pending null and an undefined proposed value as identical', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'prop-1', proposedValue: null });
    const result = await proposeTarget(
      makeInput({ validatedChanges: [makeChange({ validatedValue: undefined })] }),
    );
    expect(result.duplicatesSkipped).toBe(1);
  });

  it('still writes a new row when the pending proposal has a different value', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'prop-1', proposedValue: 4500 });
    const result = await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    expect(result).toEqual({ fieldProposals: 1, noteItems: 0, duplicatesSkipped: 0 });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('dedupes per change: skips the duplicate, writes the other', async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ id: 'prop-1', proposedValue: 5000 })
      .mockResolvedValueOnce(null);
    const result = await proposeTarget(
      makeInput({
        validatedChanges: [
          makeChange({ field: 'budget' }),
          makeChange({ field: 'status', validatedValue: 'live' }),
        ],
      }),
    );
    expect(result).toEqual({ fieldProposals: 1, noteItems: 0, duplicatesSkipped: 1 });
    expect(mocks.create.mock.calls[0]![0].data.property).toBe('status');
  });
});

describe('proposeTarget: note batches', () => {
  it('writes ONE additional_update row per target with the union of source files', async () => {
    const notes = [
      { text: 'Client prefers Tuesday syncs', source_file_ids: ['file-1', 'file-2'] },
      { text: 'Legal review pending', source_file_ids: ['file-2', 'file-3'] },
    ];
    const result = await proposeTarget(makeInput({ notes }));

    expect(result).toEqual({ fieldProposals: 0, noteItems: 2, duplicatesSkipped: 0 });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      kind: 'additional_update',
      property: '__note__',
      entityType: 'campaign',
      accountId: 'acct-1',
      campaignId: 'camp-1',
      currentValue: Prisma.JsonNull,
      proposedValue: { items: notes },
      reasoning: null,
      sourceFileIds: ['file-1', 'file-2', 'file-3'],
      confidence: null,
      state: 'pending',
      reviewerEmail: 'reviewer@example.com',
      reviewerStaffId: 'staff-1',
    });
    expect(data.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
    expect(data.reviewToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes both field rows and a note batch in one call, field rows first', async () => {
    const result = await proposeTarget(
      makeInput({
        validatedChanges: [makeChange()],
        notes: [{ text: 'Note A', source_file_ids: ['file-9'] }],
      }),
    );
    expect(result).toEqual({ fieldProposals: 1, noteItems: 1, duplicatesSkipped: 0 });
    expect(mocks.create.mock.calls.map((c) => c[0].data.kind)).toEqual([
      'field_change',
      'additional_update',
    ]);
  });

  it('writes nothing for an empty change set', async () => {
    const result = await proposeTarget(makeInput());
    expect(result).toEqual({ fieldProposals: 0, noteItems: 0, duplicatesSkipped: 0 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('puts account-level notes on the account card', async () => {
    await proposeTarget(
      makeInput({
        entityType: 'account',
        entityStatus: 'account',
        entityId: 'acct-9',
        notes: [{ text: 'Renewal in Q3', source_file_ids: ['file-1'] }],
      }),
    );
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      entityType: 'account',
      accountId: 'acct-9',
      campaignId: null,
    });
  });
});

describe('proposeTarget: new-candidate fallback', () => {
  it('routes a new candidate to one marked note batch on the ACCOUNT card', async () => {
    const result = await proposeTarget(
      makeInput({
        entityStatus: 'new',
        entityId: null,
        entityName: 'Summer Promo',
        validatedChanges: [
          makeChange({ field: 'budget', proposedValueRaw: '9000', sourceFileIds: ['file-1'] }),
        ],
        notes: [{ text: 'Kickoff next week', source_file_ids: ['file-2'] }],
      }),
    );

    expect(result).toEqual({ fieldProposals: 0, noteItems: 2, duplicatesSkipped: 0 });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      kind: 'additional_update',
      property: '__note__',
      entityType: 'account',
      accountId: 'acct-1',
      campaignId: null,
      sourceFileIds: ['file-1', 'file-2'],
      reviewerStaffId: 'staff-1',
    });
    expect(data.proposedValue).toEqual({
      items: [
        {
          text: '[new campaign candidate "Summer Promo"] budget: 9000',
          source_file_ids: ['file-1'],
        },
        {
          text: '[new campaign candidate "Summer Promo"] Kickoff next week',
          source_file_ids: ['file-2'],
        },
      ],
    });
  });

  it('renders a null raw value as "(null)"', async () => {
    await proposeTarget(
      makeInput({
        entityStatus: 'new',
        entityId: null,
        entityName: 'Summer Promo',
        validatedChanges: [makeChange({ field: 'owner', proposedValueRaw: null })],
      }),
    );
    expect(mocks.create.mock.calls[0]![0].data.proposedValue.items[0].text).toBe(
      '[new campaign candidate "Summer Promo"] owner: (null)',
    );
  });

  it('also takes the fallback for a campaign target without an id, whatever its status', async () => {
    await proposeTarget(
      makeInput({
        entityStatus: 'existing',
        entityId: null,
        entityName: 'Ghost Campaign',
        notes: [{ text: 'Seen in a folder name', source_file_ids: [] }],
      }),
    );
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data.entityType).toBe('account');
    expect(data.campaignId).toBeNull();
    expect(data.proposedValue.items[0].text).toBe(
      '[new campaign candidate "Ghost Campaign"] Seen in a folder name',
    );
  });

  it('writes nothing when a new candidate has no changes and no notes', async () => {
    const result = await proposeTarget(
      makeInput({ entityStatus: 'new', entityId: null, entityName: 'Empty' }),
    );
    expect(result).toEqual({ fieldProposals: 0, noteItems: 0, duplicatesSkipped: 0 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('loadPendingNoteTexts', () => {
  it('queries pending, unexpired __note__ additional_updates for the exact target', async () => {
    await loadPendingNoteTexts({
      entityType: 'campaign',
      accountId: 'acct-1',
      campaignId: 'camp-1',
    });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        kind: 'additional_update',
        property: '__note__',
        entityType: 'campaign',
        accountId: 'acct-1',
        campaignId: 'camp-1',
        state: 'pending',
        expiresAt: { gt: NOW },
      },
      select: { proposedValue: true },
    });
  });

  it('flattens item texts across rows in order', async () => {
    mocks.findMany.mockResolvedValue([
      { proposedValue: { items: [{ text: 'first' }, { text: 'second' }] } },
      { proposedValue: { items: [{ text: 'third' }] } },
    ]);
    await expect(
      loadPendingNoteTexts({ entityType: 'account', accountId: 'acct-1', campaignId: null }),
    ).resolves.toEqual(['first', 'second', 'third']);
  });

  it('drops blank, non-string and malformed items and tolerates null / itemless values', async () => {
    mocks.findMany.mockResolvedValue([
      { proposedValue: null },
      { proposedValue: {} },
      {
        proposedValue: {
          items: [{ text: '   ' }, { text: '' }, { text: 42 }, {}, null, { text: 'kept' }],
        },
      },
    ]);
    await expect(
      loadPendingNoteTexts({ entityType: 'account', accountId: 'acct-1', campaignId: null }),
    ).resolves.toEqual(['kept']);
  });

  it('returns an empty list when nothing is pending', async () => {
    await expect(
      loadPendingNoteTexts({ entityType: 'account', accountId: 'acct-1', campaignId: null }),
    ).resolves.toEqual([]);
  });
});
