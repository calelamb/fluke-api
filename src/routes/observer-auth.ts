import type { Prisma, User } from '@prisma/client';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AuthAppleRequestSchema,
  AuthAppleResponseSchema,
  DeleteAccountResponseSchema,
  type AuthenticatedUser,
} from '../contracts/index.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { clearAdminCookie, requireAdmin } from '../lib/auth.js';
import {
  clearObserverCookies,
  issueCsrfToken,
  requireCsrf,
} from '../lib/csrf.js';
import {
  OBSERVER_COOKIE_NAME,
  issueObserverSession,
  requireObserver,
  resolveOptionalObserver,
} from '../lib/observer-auth.js';
import type { StorageBackend } from '../lib/storage.js';
import type { TokenCrypto } from '../lib/token-crypto.js';
import {
  deleteObserverAccount,
  type CleanupFailure,
} from '../services/account-deletion.js';
import type {
  AppleAuthErrorCode,
  AppleAuthService,
  AppleTokenSet,
  VerifiedAppleIdentity,
} from '../services/apple-auth.js';

const APPLE_SIGN_IN_LIMIT_MAX = 10;
const APPLE_SIGN_IN_WINDOW = '1 hour';
const DeleteAccountRequestSchema = AuthAppleRequestSchema.omit({ fullName: true });
const VerifiedEmailSchema = z.string().trim().toLowerCase().email().max(320);

type AppleAuthClient = Pick<
  AppleAuthService,
  'exchangeAppleAuthorizationCode' | 'revokeAppleRefreshToken' | 'verifyAppleIdentityToken'
>;
type TokenCipher = Pick<TokenCrypto, 'decryptToken' | 'encryptToken'>;

export interface ObserverAuthRouteOptions {
  readonly appleAuth: AppleAuthClient;
  readonly storage: StorageBackend;
  readonly tokenCrypto: TokenCipher;
}

class ObserverRouteError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly failureKind: string,
  ) {
    super(statusCode >= 500 ? 'Authentication provider unavailable.' : 'Authentication failed.');
    this.name = 'ObserverRouteError';
  }
}

function appleFailureCode(error: unknown): AppleAuthErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('APPLE_')
    ? code as AppleAuthErrorCode
    : null;
}

function mapAppleError(error: unknown): ObserverRouteError {
  const code = appleFailureCode(error);
  if (code === 'APPLE_UPSTREAM_UNAVAILABLE' || code === 'APPLE_CONFIG_INVALID') {
    return new ObserverRouteError(503, 'apple-provider');
  }
  return new ObserverRouteError(401, 'apple-credential');
}

function isUniqueConstraintConflict(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'P2002';
}

function verifiedEmail(identity: VerifiedAppleIdentity): string | null {
  if (identity.email === undefined || identity.emailVerified !== true) {
    return null;
  }
  const parsed = VerifiedEmailSchema.safeParse(identity.email);
  if (!parsed.success) {
    throw new ObserverRouteError(401, 'apple-email');
  }
  return parsed.data;
}

function publicObserver(user: Pick<User, 'displayName' | 'email' | 'id' | 'role'>): AuthenticatedUser {
  if (user.role !== 'OBSERVER') {
    throw new ObserverRouteError(409, 'role-conflict');
  }
  return Object.freeze({
    displayName: user.displayName,
    email: user.email,
    id: user.id,
    role: 'OBSERVER',
  });
}

async function findEmailCollision(
  transaction: Prisma.TransactionClient,
  email: string | null,
  currentUserId?: string,
): Promise<boolean> {
  if (email === null) {
    return false;
  }
  const owner = await transaction.user.findUnique({ where: { email } });
  return owner !== null && owner.id !== currentUserId;
}

async function persistObserver(
  identity: VerifiedAppleIdentity,
  tokenSet: AppleTokenSet,
  fullName: string | null | undefined,
  tokenCrypto: TokenCipher,
): Promise<User> {
  const email = verifiedEmail(identity);
  const refreshCiphertext = tokenCrypto.encryptToken(tokenSet.refreshToken);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.user.findUnique({
      where: { appleSub: identity.subject },
    });
    if (existing !== null) {
      if (existing.role !== 'OBSERVER' || await findEmailCollision(transaction, email, existing.id)) {
        throw new ObserverRouteError(409, 'identity-conflict');
      }
      const identityUpdates = {
        ...(email === null ? {} : { email }),
        ...(existing.displayName === null && fullName ? { displayName: fullName } : {}),
      };
      return transaction.user.update({
        data: {
          appleRefreshTokenCiphertext: refreshCiphertext,
          ...identityUpdates,
        },
        where: { id: existing.id },
      });
    }
    if (await findEmailCollision(transaction, email)) {
      throw new ObserverRouteError(409, 'email-conflict');
    }
    return transaction.user.create({
      data: {
        appleRefreshTokenCiphertext: refreshCiphertext,
        appleSub: identity.subject,
        displayName: fullName ?? null,
        email,
        passwordHash: null,
        role: 'OBSERVER',
        sessionVersion: 1,
      },
    });
  });
}

async function verifyAppleRequest(
  body: z.infer<typeof DeleteAccountRequestSchema>,
  appleAuth: AppleAuthClient,
): Promise<{ readonly identity: VerifiedAppleIdentity; readonly tokenSet: AppleTokenSet }> {
  try {
    const identity = await appleAuth.verifyAppleIdentityToken(body.identityToken, body.nonce);
    const tokenSet = await appleAuth.exchangeAppleAuthorizationCode(
      body.authorizationCode,
      identity.subject,
    );
    if (tokenSet.subject !== identity.subject) {
      throw new ObserverRouteError(401, 'apple-subject-mismatch');
    }
    return { identity, tokenSet };
  } catch (error: unknown) {
    if (error instanceof ObserverRouteError) {
      throw error;
    }
    throw mapAppleError(error);
  }
}

export function logCleanupFailure(
  logger: Pick<FastifyBaseLogger, 'error'>,
  requestId: string,
  failure: CleanupFailure,
): void {
  const attempts = Number.isInteger(failure.attempts)
    ? Math.min(Math.max(failure.attempts, 0), 5)
    : 0;
  logger.error({
    attempts,
    failureKind: 'storage-cleanup',
    requestId,
  }, 'account object cleanup failed');
}

async function sendMe(request: FastifyRequest, reply: Parameters<typeof requireAdmin>[1]) {
  const observer = await resolveOptionalObserver(request, reply);
  if (observer !== null) {
    return {
      displayName: observer.displayName,
      email: observer.email,
      id: observer.id,
      role: observer.role,
      userId: observer.id,
    };
  }
  await requireAdmin(request, reply);
  return request.admin;
}

export default async function observerAuthRoutes(
  app: FastifyInstance,
  options: ObserverAuthRouteOptions,
): Promise<void> {
  app.post('/apple', {
    config: { rateLimit: { max: APPLE_SIGN_IN_LIMIT_MAX, timeWindow: APPLE_SIGN_IN_WINDOW } },
  }, async (request, reply) => {
    const parsed = AuthAppleRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ObserverRouteError(400, 'validation');
    }
    try {
      const verified = await verifyAppleRequest(parsed.data, options.appleAuth);
      const user = await persistObserver(
        verified.identity,
        verified.tokenSet,
        parsed.data.fullName,
        options.tokenCrypto,
      );
      await issueObserverSession(reply, {
        id: user.id,
        role: 'OBSERVER',
        sessionVersion: user.sessionVersion,
      });
      const csrfToken = issueCsrfToken(reply);
      return AuthAppleResponseSchema.parse({ csrfToken, user: publicObserver(user) });
    } catch (error: unknown) {
      const mapped = error instanceof ObserverRouteError
        ? error
        : isUniqueConstraintConflict(error)
          ? new ObserverRouteError(409, 'identity-conflict')
          : null;
      request.log.warn({
        failureKind: mapped?.failureKind ?? 'observer-persistence',
        requestId: request.id,
      }, 'observer sign-in rejected');
      throw mapped ?? error;
    }
  });

  app.get('/me', async (request, reply) => sendMe(request, reply));

  app.post('/logout', async (request, reply) => {
    if (request.cookies[OBSERVER_COOKIE_NAME] === undefined) {
      clearAdminCookie(reply, env.ADMIN_COOKIE_NAME);
      return { ok: true };
    }
    await requireObserver(request, reply);
    await requireCsrf(request, reply);
    const observer = request.observer;
    if (observer === undefined) {
      throw new ObserverRouteError(401, 'observer-session');
    }
    const invalidated = await prisma.user.updateMany({
      data: { sessionVersion: { increment: 1 } },
      where: {
        id: observer.id,
        role: 'OBSERVER',
        sessionVersion: observer.sessionVersion,
      },
    });
    if (invalidated.count !== 1) {
      throw new ObserverRouteError(401, 'observer-session');
    }
    clearObserverCookies(reply);
    return { ok: true };
  });

  app.delete('/account', async (request, reply) => {
    await requireObserver(request, reply);
    await requireCsrf(request, reply);
    const parsed = DeleteAccountRequestSchema.safeParse(request.body);
    if (!parsed.success || request.observer === undefined) {
      throw new ObserverRouteError(400, 'validation');
    }
    const verified = await verifyAppleRequest(parsed.data, options.appleAuth);
    const observerRecord = await prisma.user.findUnique({
      where: { id: request.observer.id },
      select: { appleSub: true },
    });
    if (
      observerRecord?.appleSub === null
      || observerRecord?.appleSub === undefined
      || verified.identity.subject !== observerRecord.appleSub
    ) {
      throw new ObserverRouteError(401, 'apple-subject-mismatch');
    }
    await deleteObserverAccount({
      appleSub: observerRecord.appleSub,
      reauthenticatedRefreshToken: verified.tokenSet.refreshToken,
      userId: request.observer.id,
    }, {
      appleAuth: options.appleAuth,
      recordCleanupFailure: (failure) => logCleanupFailure(request.log, request.id, failure),
      storage: options.storage,
      tokenCrypto: options.tokenCrypto,
    });
    clearObserverCookies(reply);
    return DeleteAccountResponseSchema.parse({ ok: true });
  });
}
