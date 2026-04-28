import type { FastifyReply, FastifyRequest } from 'fastify';
import { isProduction } from '../env.js';

export interface AdminClaims {
  userId: string;
  email: string;
  role: 'ADMIN' | 'MODERATOR';
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminClaims;
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  try {
    const decoded = await req.jwtVerify<AdminClaims>();
    req.admin = decoded;
  } catch {
    reply.code(401).send({ error: 'Unauthorized' });
  }
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
