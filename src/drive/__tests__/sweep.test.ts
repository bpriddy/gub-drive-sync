import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('../../prisma', () => ({
  prisma: { driveChangeProposal: { updateMany: mocks.updateMany } },
}));
vi.mock('../../logger', () => ({ logger: { info: mocks.loggerInfo } }));

import { sweepExpiredProposals } from '../sweep';

const NOW = new Date('2030-03-05T08:30:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.updateMany.mockReset().mockResolvedValue({ count: 0 });
  mocks.loggerInfo.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sweepExpiredProposals', () => {
  it('flips only PENDING proposals whose expiry is strictly before now to expired', async () => {
    await sweepExpiredProposals();
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { state: 'pending', expiresAt: { lt: NOW } },
      data: { state: 'expired' },
    });
  });

  it('returns the number of rows expired and logs it', async () => {
    mocks.updateMany.mockResolvedValue({ count: 5 });
    await expect(sweepExpiredProposals()).resolves.toEqual({ expired: 5 });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { expired: 5 },
      '[drive.sweep] swept expired proposals',
    );
  });

  it('is a quiet no-op when nothing has expired', async () => {
    await expect(sweepExpiredProposals()).resolves.toEqual({ expired: 0 });
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
  });

  it('propagates a database failure', async () => {
    mocks.updateMany.mockRejectedValue(new Error('db unavailable'));
    await expect(sweepExpiredProposals()).rejects.toThrow('db unavailable');
  });
});
