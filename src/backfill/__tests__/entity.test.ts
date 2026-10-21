/**
 * loadEntity must not read accounts.drive_bootstrap_files: the column is the
 * bootstrap files cache, it grows with the drive, and loadEntity runs for
 * every driver (the forward one never uses the cache). Prisma is mocked and
 * the call it receives is inspected — a `select` that leaves the column out is
 * the only way to keep it from being read (Prisma 5 has no `omit` without a
 * preview flag in the shared generator block).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    account: { findUniqueOrThrow: vi.fn() },
    campaign: { findUniqueOrThrow: vi.fn() },
  },
}));

vi.mock('../../prisma', () => ({ prisma: prismaMock }));

import { loadEntity } from '../entity';
import type { Args } from '../args';

/** Every Account scalar the generated client knows, minus the cache column. */
const SCALARS_WITHOUT_CACHE = Object.values(Prisma.AccountScalarFieldEnum)
  .filter((field) => field !== 'driveBootstrapFiles')
  .sort();

const OWNER = { id: 'staff-1', email: 'owner@example.com' };

/** A row as the narrowed select returns it: every scalar but the cache. */
function accountRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of SCALARS_WITHOUT_CACHE) row[field] = null;
  return {
    ...row,
    id: 'acc-1',
    name: 'Acme',
    driveFolderId: 'folder-acme',
    driveBootstrapCursor: new Date('2024-03-01T00:00:00Z'),
    driveStructureClassification: { fingerprint: 'abc' },
    statusMarkdown: '- Acme is a test account',
    owner: OWNER,
    ...over,
  };
}

const base = { newestFirst: false, outputPath: null, structureOnly: false, dryrun: false };
const accountArgs: Args = { ...base, accountId: 'acc-1' };
const campaignArgs: Args = { ...base, campaignId: 'camp-1' };

beforeEach(() => {
  prismaMock.account.findUniqueOrThrow.mockReset();
  prismaMock.campaign.findUniqueOrThrow.mockReset();
});

describe('loadEntity — the files cache stays out of the row', () => {
  it('account scan: selects every scalar except drive_bootstrap_files, plus the owner', async () => {
    prismaMock.account.findUniqueOrThrow.mockResolvedValue(accountRow());

    await loadEntity(accountArgs);

    expect(prismaMock.account.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    const call = prismaMock.account.findUniqueOrThrow.mock.calls[0]![0];
    expect(call.where).toEqual({ id: 'acc-1' });
    // An `include` loads every scalar of the model, the cache column included.
    expect(call.include).toBeUndefined();
    expect(call.select).not.toHaveProperty('driveBootstrapFiles');
    const selectedScalars = Object.keys(call.select)
      .filter((key) => key !== 'owner')
      .sort();
    // Derived from the generated enum, so a column added to Account later is
    // loaded too — this fails if a hand-maintained list falls behind.
    expect(selectedScalars).toEqual(SCALARS_WITHOUT_CACHE);
    for (const field of selectedScalars) expect(call.select[field]).toBe(true);
    expect(call.select.owner).toEqual({ select: { id: true, email: true } });
  });

  it('campaign scan: the parent account is selected the same way', async () => {
    prismaMock.campaign.findUniqueOrThrow.mockResolvedValue({
      id: 'camp-1',
      name: 'Spring launch',
      driveFolderId: 'folder-spring',
      statusMarkdown: null,
      statusSensitiveMarkdown: null,
      status: 'pitch',
      budget: null,
      awardedAt: null,
      liveAt: null,
      endsAt: null,
      account: accountRow(),
    });

    await loadEntity(campaignArgs);

    const call = prismaMock.campaign.findUniqueOrThrow.mock.calls[0]![0];
    expect(call.where).toEqual({ id: 'camp-1' });
    // The campaign's own columns are untouched: no top-level `select`.
    expect(call.select).toBeUndefined();
    const account = call.include.account;
    expect(account.include).toBeUndefined();
    expect(account.select).not.toHaveProperty('driveBootstrapFiles');
    expect(
      Object.keys(account.select)
        .filter((key) => key !== 'owner')
        .sort(),
    ).toEqual(SCALARS_WITHOUT_CACHE);
    expect(account.select.owner).toEqual({ select: { id: true, email: true } });
  });

  it('keeps the other cached blob (structure classification) and the rest of the ctx', async () => {
    prismaMock.account.findUniqueOrThrow.mockResolvedValue(accountRow());

    const ctx = await loadEntity(accountArgs);

    expect(ctx).toMatchObject({
      type: 'account',
      id: 'acc-1',
      name: 'Acme',
      folderId: 'folder-acme',
      accountId: 'acc-1',
      accountFolderId: 'folder-acme',
      driveBootstrapCursor: '2024-03-01',
      driveStructureClassification: { fingerprint: 'abc' },
      statusMarkdown: '- Acme is a test account',
      reviewerEmail: 'owner@example.com',
      reviewerStaffId: 'staff-1',
    });
    // The ctx no longer carries the cache at all: the bootstrap path asks for it.
    expect(ctx).not.toHaveProperty('driveBootstrapFiles');
  });

  it('campaign ctx carries no cache either, and still maps the parent account', async () => {
    prismaMock.campaign.findUniqueOrThrow.mockResolvedValue({
      id: 'camp-1',
      name: 'Spring launch',
      driveFolderId: 'folder-spring',
      statusMarkdown: null,
      statusSensitiveMarkdown: null,
      status: 'pitch',
      budget: null,
      awardedAt: null,
      liveAt: null,
      endsAt: null,
      account: accountRow(),
    });

    const ctx = await loadEntity(campaignArgs);

    expect(ctx).toMatchObject({
      type: 'campaign',
      id: 'camp-1',
      accountId: 'acc-1',
      accountFolderId: 'folder-acme',
      driveBootstrapCursor: '2024-03-01',
      driveStructureClassification: { fingerprint: 'abc' },
    });
    expect(ctx).not.toHaveProperty('driveBootstrapFiles');
  });
});
