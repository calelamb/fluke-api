import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, isProduction } from '../env.js';
import { OBSERVER_COOKIE_NAME } from './observer-auth.js';

export const CSRF_COOKIE_NAME = 'fluke_csrf';

const CSRF_HEADER_NAME = 'x-fluke-csrf';
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u;
const MAX_CSRF_TOKEN_LENGTH = 512;
const MAX_ORIGIN_LENGTH = 2_048;
const MINIMUM_SECRET_LENGTH = 43;

export class CsrfError extends Error {
  readonly statusCode = 403;

  constructor() {
    super('Forbidden');
    this.name = 'CsrfError';
  }
}

function csrfSecret(): string {
  const secret = process.env.OBSERVER_CSRF_SECRET;
  if (!secret || secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error('Observer CSRF configuration is invalid');
  }
  return secret;
}

function signature(rawToken: string): string {
  return createHmac('sha256', csrfSecret()).update(rawToken, 'utf8').digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hasAllowedOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  if (origin.length === 0 || origin.length > MAX_ORIGIN_LENGTH) {
    return false;
  }

  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.origin !== origin) {
      return false;
    }
    return env.WEB_ORIGIN.some((allowed) => new URL(allowed).origin === parsedOrigin.origin);
  } catch {
    return false;
  }
}

function isValidSignedToken(token: string): boolean {
  if (token.length > MAX_CSRF_TOKEN_LENGTH || !CSRF_TOKEN_PATTERN.test(token)) {
    return false;
  }
  const [rawToken, suppliedSignature] = token.split('.');
  return safeEqual(suppliedSignature, signature(rawToken));
}

export function issueCsrfToken(reply: FastifyReply): string {
  const rawToken = randomBytes(32).toString('base64url');
  const token = `${rawToken}.${signature(rawToken)}`;
  reply.setCookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    path: '/api/v1',
    sameSite: 'lax',
    secure: isProduction,
  });
  return token;
}

export async function requireCsrf(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const cookieToken = request.cookies[CSRF_COOKIE_NAME];
  const headerToken = request.headers[CSRF_HEADER_NAME];
  if (
    typeof cookieToken !== 'string'
    || typeof headerToken !== 'string'
    || !hasAllowedOrigin(request)
    || !safeEqual(cookieToken, headerToken)
    || !isValidSignedToken(cookieToken)
  ) {
    throw new CsrfError();
  }
}

export function clearObserverCookies(reply: FastifyReply): void {
  reply.clearCookie(OBSERVER_COOKIE_NAME, {
    httpOnly: true,
    path: '/api/v1',
    sameSite: 'lax',
    secure: isProduction,
  });
  reply.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    path: '/api/v1',
    sameSite: 'lax',
    secure: isProduction,
  });
}
