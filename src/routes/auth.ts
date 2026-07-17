import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { clearAdminCookie, requireAdmin, setAdminCookie } from '../lib/auth.js';

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export default async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user?.passwordHash || !user.email) {
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
