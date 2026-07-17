import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { prisma } from '../db.js';
import { isProduction } from '../env.js';

export const OBSERVER_COOKIE_NAME = 'fluke_observer';
export const OBSERVER_AUDIENCE = 'fluke-ios-observer';
export const OBSERVER_ISSUER = 'fluke-api';

const OBSERVER_SESSION_TYPE = 'observer-session';
const OBSERVER_SESSION_SECONDS = 60 * 60 * 24 * 7;
const MINIMUM_SECRET_LENGTH = 43;
const ALLOWED_CLAIM_NAMES = new Set([
  'aud',
  'exp',
  'iat',
  'iss',
  'role',
  'sessionVersion',
  'sub',
  'type',
]);

export interface ObserverClaims extends JWTPayload {
  readonly aud: typeof OBSERVER_AUDIENCE;
  readonly iss: typeof OBSERVER_ISSUER;
  readonly role: 'OBSERVER';
  readonly sessionVersion: number;
  readonly sub: string;
  readonly type: typeof OBSERVER_SESSION_TYPE;
}

export interface ObserverPrincipal {
  readonly displayName: string | null;
  readonly email: string | null;
  readonly id: string;
  readonly role: 'OBSERVER';
  readonly sessionVersion: number;
}

export interface ObserverSessionUser {
  readonly id: string;
  readonly role: 'OBSERVER';
  readonly sessionVersion: number;
}

export class ObserverAuthError extends Error {
  readonly statusCode = 401;

  constructor() {
    super('Unauthorized');
    this.name = 'ObserverAuthError';
  }
}

class ObserverConfigurationError extends Error {
  constructor() {
    super('Observer session configuration is invalid');
    this.name = 'ObserverConfigurationError';
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    observer?: ObserverPrincipal;
  }
}

function observerSecret(): Uint8Array {
  const secret = process.env.OBSERVER_JWT_SECRET;
  if (!secret || secret.length < MINIMUM_SECRET_LENGTH) {
    throw new ObserverConfigurationError();
  }
  return new TextEncoder().encode(secret);
}

function hasExactObserverClaims(payload: JWTPayload): payload is ObserverClaims {
  const claimNames = Object.keys(payload);
  return (
    claimNames.every((name) => ALLOWED_CLAIM_NAMES.has(name))
    && claimNames.length === ALLOWED_CLAIM_NAMES.size
    && payload.aud === OBSERVER_AUDIENCE
    && payload.iss === OBSERVER_ISSUER
    && payload.role === 'OBSERVER'
    && Number.isInteger(payload.sessionVersion)
    && typeof payload.sessionVersion === 'number'
    && payload.sessionVersion >= 0
    && typeof payload.sub === 'string'
    && payload.sub.length > 0
    && payload.type === OBSERVER_SESSION_TYPE
    && typeof payload.iat === 'number'
    && typeof payload.exp === 'number'
  );
}

export async function issueObserverSession(
  reply: FastifyReply,
  user: ObserverSessionUser,
): Promise<string> {
  if (user.role !== 'OBSERVER' || !Number.isInteger(user.sessionVersion) || user.sessionVersion < 0) {
    throw new Error('Cannot issue an observer session for this user');
  }

  const token = await new SignJWT({
    role: 'OBSERVER',
    sessionVersion: user.sessionVersion,
    type: OBSERVER_SESSION_TYPE,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(OBSERVER_AUDIENCE)
    .setIssuer(OBSERVER_ISSUER)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${OBSERVER_SESSION_SECONDS}s`)
    .sign(observerSecret());

  reply.setCookie(OBSERVER_COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: OBSERVER_SESSION_SECONDS,
    path: '/api/v1',
    sameSite: 'lax',
    secure: isProduction,
  });
  return token;
}

export async function resolveObserverFromToken(token: string): Promise<ObserverPrincipal> {
  let claims: ObserverClaims;
  try {
    const verified = await jwtVerify(token, observerSecret(), {
      algorithms: ['HS256'],
      audience: OBSERVER_AUDIENCE,
      issuer: OBSERVER_ISSUER,
      typ: 'JWT',
    });
    if (!hasExactObserverClaims(verified.payload)) {
      throw new ObserverAuthError();
    }
    claims = verified.payload;
  } catch (error: unknown) {
    if (error instanceof ObserverConfigurationError) {
      throw error;
    }
    throw new ObserverAuthError();
  }

  // Deliberately outside the JWT catch: database failures are operational
  // failures and must reach the app's canonical 5xx boundary and structured log.
  const observer = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      displayName: true,
      email: true,
      id: true,
      role: true,
      sessionVersion: true,
    },
  });
  if (observer?.role !== 'OBSERVER' || observer.sessionVersion !== claims.sessionVersion) {
    throw new ObserverAuthError();
  }

  return Object.freeze({
    displayName: observer.displayName,
    email: observer.email,
    id: observer.id,
    role: observer.role,
    sessionVersion: observer.sessionVersion,
  });
}

export async function resolveOptionalObserver(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<ObserverPrincipal | null> {
  const token = request.cookies[OBSERVER_COOKIE_NAME];
  if (token === undefined) {
    return null;
  }
  return resolveObserverFromToken(token);
}

export async function requireObserver(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const observer = await resolveOptionalObserver(request, reply);
  if (observer === null) {
    throw new ObserverAuthError();
  }
  request.observer = observer;
}
