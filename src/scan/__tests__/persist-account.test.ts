/**
 * persistTarget's account write reads back only the id. Without a `select`,
 * Prisma's update returns every column of the row, and `accounts` carries the
 * bootstrap files cache (drive_bootstrap_files, tens of MiB on a large drive):
 * every account write in a bootstrap chunk would pull the cache back into the
 * job's memory.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityCtx } from '../batch-types';

// config.ts validates the environment on import; the AI module pulls it in.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const m = vi.hoisted(() => {
  const tx = {
    account: { update: vi.fn() },
    accountChange: { create: vi.fn() },
  };
  return {
    tx,
    prisma: { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) },
  };
});

vi.mock('../../prisma', () => ({ prisma: m.prisma }));
vi.mock('../../ai', () => ({ parseLlmJson: vi.fn(), runPreset: vi.fn() }));

import { persistTarget } from '../persist';

beforeEach(() => {
  m.tx.account.update.mockReset();
  m.tx.account.update.mockResolvedValue({ id: 'acc-1' });
  m.tx.accountChange.create.mockReset();
});

describe('persistTarget (account)', () => {
  it('reads back only the id from the account update', async () => {
    await persistTarget({
      target: {
        entityType: 'account',
        entityName: 'Account',
        entityStatus: 'account',
        entityId: 'acc-1',
        campaignFolderId: null,
        campaignFolderPath: null,
      },
      ctx: { type: 'account', id: 'acc-1' } as EntityCtx,
      validatedChanges: [],
      synthesizedMarkdown: 'status',
      synthesizedSensitiveMarkdown: null,
    });

    expect(m.tx.account.update).toHaveBeenCalledTimes(1);
    const arg = m.tx.account.update.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: 'acc-1' });
    expect(arg.data).toEqual({ statusMarkdown: 'status' });
    expect(arg.select).toEqual({ id: true });
  });
});
