import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import {
  clearAdminCookie,
  isAdminRole,
  requireAdmin,
  setAdminCookie,
} from '../lib/auth.js';

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1_024),
});

const ADMIN_LOGIN_LIMIT_MAX = 5;
const ADMIN_LOGIN_WINDOW = '15 minutes';

function accountRateLimitKey(email: string): string {
  const digest = createHash('sha256').update(email, 'utf8').digest('base64url');
  return `admin-account:${digest}`;
}

export default async function authRoutes(app: FastifyInstance) {
  const checkAccountRateLimit = app.createRateLimit({
    keyGenerator: (request) => {
      const parsed = LoginBody.safeParse(request.body);
      return parsed.success
        ? accountRateLimitKey(parsed.data.email)
        : `admin-invalid:${request.ip}`;
    },
    max: ADMIN_LOGIN_LIMIT_MAX,
    timeWindow: ADMIN_LOGIN_WINDOW,
  });
  const requireAccountRateLimit = async (request: Parameters<typeof checkAccountRateLimit>[0]) => {
    const result = await checkAccountRateLimit(request);
    if (!result.isAllowed && result.isExceeded) {
      const error = new Error('Rate limit exceeded');
      Object.assign(error, { statusCode: 429 });
      throw error;
    }
  };

  app.post('/login', {
    config: {
      rateLimit: { max: ADMIN_LOGIN_LIMIT_MAX, timeWindow: ADMIN_LOGIN_WINDOW },
    },
    preHandler: requireAccountRateLimit,
  }, async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      await bcrypt.compare(password, '$2a$12$invalidplaceholderhashvalueplaceholder');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    if (!isAdminRole(user.role)) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    if (!user.passwordHash || !user.email) {
      await bcrypt.compare(password, '$2a$12$invalidplaceholderhashvalueplaceholder');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const token = app.jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      { expiresIn: '7d' },
    );

    setAdminCookie(reply, token, env.ADMIN_COOKIE_NAME);

    return { ok: true, email: user.email, role: user.role };
  });

  app.post('/logout', async (_req, reply) => {
    clearAdminCookie(reply, env.ADMIN_COOKIE_NAME);
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAdmin }, async (req) => req.admin);
}
