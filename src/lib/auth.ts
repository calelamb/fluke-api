import type { FastifyReply, FastifyRequest } from 'fastify';
import { isProduction } from '../env.js';

export interface AdminClaims {
  userId: string;
  email: string;
  role: 'ADMIN' | 'MODERATOR';
}

export function isAdminRole(role: unknown): role is AdminClaims['role'] {
  return role === 'ADMIN' || role === 'MODERATOR';
}

export function isAdminClaims(value: unknown): value is AdminClaims {
  if (typeof value !== 'object' || value === null) return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.userId === 'string' &&
    typeof claims.email === 'string' &&
    isAdminRole(claims.role)
  );
}

export async function resolveOptionalAdmin(req: FastifyRequest): Promise<AdminClaims | null> {
  try {
    const decoded = await req.jwtVerify<Record<string, unknown>>();
    return isAdminClaims(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminClaims;
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const admin = await resolveOptionalAdmin(req);
  if (admin === null) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  req.admin = admin;
}

export function setAdminCookie(reply: FastifyReply, token: string, cookieName: string) {
  reply.setCookie(cookieName, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function clearAdminCookie(reply: FastifyReply, cookieName: string) {
  reply.clearCookie(cookieName, { path: '/' });
}
