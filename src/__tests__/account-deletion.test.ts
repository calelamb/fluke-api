import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    auditLog: { deleteMany: vi.fn() },
    sighting: { deleteMany: vi.fn(), updateMany: vi.fn() },
    sightingPhoto: { findMany: vi.fn() },
    submissionIdempotency: { deleteMany: vi.fn() },
    user: { delete: vi.fn(), findUnique: vi.fn() },
  },
}));

const { prisma } = await import('../db.js');

const appleAuth = Object.freeze({
  revokeAppleRefreshToken: vi.fn(),
});
const tokenCrypto = Object.freeze({
  decryptToken: vi.fn(),
});
const storage = Object.freeze({
  publicUrl: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
});
const recordCleanupFailure = vi.fn();

const observer = Object.freeze({
  appleRefreshTokenCiphertext: 'encrypted-refresh',
  appleSub: 'apple-subject-1',
  id: 'observer-1',
});

describe('deleteObserverAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appleAuth.revokeAppleRefreshToken).mockResolvedValue(undefined);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(observer as never);
    vi.mocked(tokenCrypto.decryptToken).mockReturnValue('stored-refresh-token');
    vi.mocked(prisma.sightingPhoto.findMany).mockResolvedValue([
      { storageKey: 'sightings/pending/photo.webp' },
      { storageKey: 'sightings/rejected/photo.webp' },
    ] as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => (
      callback(prisma as never)
    ) as never);
  });

  it('revokes Apple tokens before deleting PII and performs the privacy transaction', async () => {
    const { deleteObserverAccount } = await import('../services/account-deletion.js');
    const events: string[] = [];
    vi.mocked(appleAuth.revokeAppleRefreshToken).mockImplementation(async (token) => {
      events.push(`revoke:${token}`);
    });
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
      events.push('transaction');
      return callback(prisma as never) as never;
    });

    await deleteObserverAccount({
      appleSub: observer.appleSub,
      reauthenticatedRefreshToken: 'fresh-refresh-token',
      userId: observer.id,
    }, {
      appleAuth,
      recordCleanupFailure,
      storage,
      tokenCrypto,
    });

    expect(events.slice(0, 3)).toEqual([
      'revoke:stored-refresh-token',
      'revoke:fresh-refresh-token',
      'transaction',
    ]);
    expect(prisma.sightingPhoto.findMany).toHaveBeenCalledWith({
      select: { storageKey: true },
      where: {
        sighting: {
          observerUserId: observer.id,
          status: { in: ['PENDING', 'REJECTED'] },
        },
      },
    });
    expect(prisma.sighting.deleteMany).toHaveBeenCalledWith({
      where: {
        observerUserId: observer.id,
        status: { in: ['PENDING', 'REJECTED'] },
      },
    });
    expect(prisma.sighting.updateMany).toHaveBeenCalledWith({
      data: {
        observerEmail: 'deleted-observer@privacy.invalid',
        observerName: null,
        observerUserId: null,
      },
      where: { observerUserId: observer.id, status: 'APPROVED' },
    });
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({ where: { userId: observer.id } });
    expect(prisma.submissionIdempotency.deleteMany).toHaveBeenCalledWith({
      where: { userId: observer.id },
    });
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: {
        id: observer.id,
        appleRefreshTokenCiphertext: observer.appleRefreshTokenCiphertext,
        appleSub: observer.appleSub,
      },
    });
    expect(storage.remove).toHaveBeenCalledTimes(2);
  });

  it('does not mutate data when stored account identity is missing or mismatched', async () => {
    const { deleteObserverAccount } = await import('../services/account-deletion.js');
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...observer, appleSub: 'other-subject' } as never);

    await expect(deleteObserverAccount({
      appleSub: observer.appleSub,
      reauthenticatedRefreshToken: 'fresh-refresh-token',
      userId: observer.id,
    }, {
      appleAuth,
      recordCleanupFailure,
      storage,
      tokenCrypto,
    })).rejects.toMatchObject({ statusCode: 401 });

    expect(appleAuth.revokeAppleRefreshToken).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stops before destructive changes when Apple revocation fails', async () => {
    const { deleteObserverAccount } = await import('../services/account-deletion.js');
    vi.mocked(appleAuth.revokeAppleRefreshToken).mockRejectedValue(new Error('provider unavailable'));

    await expect(deleteObserverAccount({
      appleSub: observer.appleSub,
      reauthenticatedRefreshToken: 'fresh-refresh-token',
      userId: observer.id,
    }, {
      appleAuth,
      recordCleanupFailure,
      storage,
      tokenCrypto,
    })).rejects.toThrow('provider unavailable');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retries object cleanup after commit and records bounded terminal failures', async () => {
    const { deleteObserverAccount } = await import('../services/account-deletion.js');
    vi.mocked(storage.remove)
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('still unavailable'));

    await deleteObserverAccount({
      appleSub: observer.appleSub,
      reauthenticatedRefreshToken: 'stored-refresh-token',
      userId: observer.id,
    }, {
      appleAuth,
      cleanupAttempts: 3,
      recordCleanupFailure,
      storage,
      tokenCrypto,
    });

    expect(storage.remove).toHaveBeenCalledTimes(5);
    expect(recordCleanupFailure).toHaveBeenCalledOnce();
    expect(recordCleanupFailure).toHaveBeenCalledWith(expect.objectContaining({
      attempts: 3,
      storageKey: 'sightings/rejected/photo.webp',
    }));
  });
});
