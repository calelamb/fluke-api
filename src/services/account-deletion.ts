import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { StorageBackend } from '../lib/storage.js';
import type { TokenCrypto } from '../lib/token-crypto.js';
import type { AppleAuthService } from './apple-auth.js';

const DEFAULT_CLEANUP_ATTEMPTS = 3;
const DELETED_OBSERVER_EMAIL = 'deleted-observer@privacy.invalid';

type AppleRevoker = Pick<AppleAuthService, 'revokeAppleRefreshToken'>;
type RefreshTokenCipher = Pick<TokenCrypto, 'decryptToken'>;

export interface AccountDeletionRequest {
  readonly appleSub: string;
  readonly reauthenticatedRefreshToken: string;
  readonly userId: string;
}

export interface CleanupFailure {
  readonly attempts: number;
  readonly error: unknown;
  readonly storageKey: string;
}

export interface AccountDeletionDependencies {
  readonly appleAuth: AppleRevoker;
  readonly cleanupAttempts?: number;
  readonly recordCleanupFailure: (failure: CleanupFailure) => void;
  readonly storage: Pick<StorageBackend, 'remove'>;
  readonly tokenCrypto: RefreshTokenCipher;
}

export class AccountDeletionAuthError extends Error {
  public readonly statusCode = 401;

  public constructor() {
    super('Authentication is required.');
    this.name = 'AccountDeletionAuthError';
  }
}

function validatedCleanupAttempts(value: number | undefined): number {
  const attempts = value ?? DEFAULT_CLEANUP_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error('Account cleanup attempts must be between 1 and 5.');
  }
  return attempts;
}

async function revokeTokens(
  appleAuth: AppleRevoker,
  tokens: readonly string[],
): Promise<void> {
  for (const token of [...new Set(tokens)]) {
    await appleAuth.revokeAppleRefreshToken(token);
  }
}

async function removeWithRetries(
  storage: Pick<StorageBackend, 'remove'>,
  storageKey: string,
  attempts: number,
): Promise<unknown | null> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await storage.remove(storageKey);
      return null;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  return lastError;
}

async function deletePrivateData(
  transaction: Prisma.TransactionClient,
  request: AccountDeletionRequest,
  refreshTokenCiphertext: string,
): Promise<readonly string[]> {
  const photos = await transaction.sightingPhoto.findMany({
    select: { storageKey: true },
    where: {
      sighting: {
        observerUserId: request.userId,
        status: { in: ['PENDING', 'REJECTED'] },
      },
    },
  });
  await transaction.sighting.deleteMany({
    where: {
      observerUserId: request.userId,
      status: { in: ['PENDING', 'REJECTED'] },
    },
  });
  await transaction.sighting.updateMany({
    data: {
      observerEmail: DELETED_OBSERVER_EMAIL,
      observerName: null,
      observerUserId: null,
    },
    where: { observerUserId: request.userId, status: 'APPROVED' },
  });
  await transaction.auditLog.deleteMany({ where: { userId: request.userId } });
  await transaction.submissionIdempotency.deleteMany({ where: { userId: request.userId } });
  await transaction.user.delete({
    where: {
      id: request.userId,
      appleRefreshTokenCiphertext: refreshTokenCiphertext,
      appleSub: request.appleSub,
    },
  });
  return photos.map(({ storageKey }) => storageKey);
}

export async function deleteObserverAccount(
  request: AccountDeletionRequest,
  dependencies: AccountDeletionDependencies,
): Promise<void> {
  const attempts = validatedCleanupAttempts(dependencies.cleanupAttempts);
  const observer = await prisma.user.findUnique({
    where: { id: request.userId },
    select: {
      appleRefreshTokenCiphertext: true,
      appleSub: true,
      id: true,
    },
  });
  if (
    observer?.appleSub !== request.appleSub
    || observer.appleRefreshTokenCiphertext === null
  ) {
    throw new AccountDeletionAuthError();
  }
  const refreshTokenCiphertext = observer.appleRefreshTokenCiphertext;

  const storedRefreshToken = dependencies.tokenCrypto.decryptToken(
    refreshTokenCiphertext,
  );
  await revokeTokens(dependencies.appleAuth, [
    storedRefreshToken,
    request.reauthenticatedRefreshToken,
  ]);

  const storageKeys = await prisma.$transaction((transaction) => (
    deletePrivateData(transaction, request, refreshTokenCiphertext)
  ));
  for (const storageKey of storageKeys) {
    const error = await removeWithRetries(dependencies.storage, storageKey, attempts);
    if (error !== null) {
      dependencies.recordCleanupFailure({ attempts, error, storageKey });
    }
  }
}
