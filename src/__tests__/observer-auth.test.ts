import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { prisma } = await import('../db.js');
const { classifyError } = await import('../lib/safe-errors.js');
const {
  OBSERVER_COOKIE_NAME,
  OBSERVER_ISSUER,
  issueObserverSession,
  requireObserver,
  resolveObserverFromToken,
  resolveOptionalObserver,
} = await import('../lib/observer-auth.js');

const OBSERVER_SECRET = 'observer-test-secret-material-that-is-longer-than-43-characters';

const OBSERVER = Object.freeze({
  displayName: 'Salish Sea Observer',
  email: 'observer@example.com',
  id: 'observer-1',
  role: 'OBSERVER' as const,
  sessionVersion: 4,
});

const OBSERVER_RECORD = Object.freeze({
  ...OBSERVER,
  appleRefreshTokenCiphertext: null,
  appleSub: 'apple-observer-sub',
  createdAt: new Date('2026-07-17T00:00:00.000Z'),
  passwordHash: null,
});

describe('observer sessions', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.OBSERVER_JWT_SECRET = OBSERVER_SECRET;
    app = Fastify({ logger: false });
    await app.register(cookie);
    app.get('/optional', async (request, reply) => {
      const observer = await resolveOptionalObserver(request, reply);
      return { observer };
    });
    app.get('/required', { preHandler: requireObserver }, async (request) => ({
      observer: request.observer,
    }));
    app.get('/issue', async (_request, reply) => {
      await issueObserverSession(reply, OBSERVER);
      return { ok: true };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(OBSERVER_RECORD);
  });

  it('issues a dedicated host-only observer cookie with bounded lifetime', async () => {
    const response = await app.inject({ method: 'GET', url: '/issue' });
    const setCookie = String(response.headers['set-cookie']);

    expect(response.statusCode).toBe(200);
    expect(setCookie).toContain(`${OBSERVER_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api/v1');
    expect(setCookie).toContain('Max-Age=604800');
    expect(setCookie).not.toContain('Domain=');
  });

  it('returns null only when the observer cookie is absent', async () => {
    const response = await app.inject({ method: 'GET', url: '/optional' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ observer: null });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('fails closed when an observer cookie is present but invalid', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/optional',
      cookies: { [OBSERVER_COOKIE_NAME]: 'invalid' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects an admin token at an observer boundary', async () => {
    const token = await new SignJWT({
      role: 'ADMIN',
      sessionVersion: 4,
      type: 'observer-session',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setAudience('fluke-ios-observer')
      .setIssuer(OBSERVER_ISSUER)
      .setSubject('admin-1')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(new TextEncoder().encode(OBSERVER_SECRET));

    await expect(resolveObserverFromToken(token)).rejects.toMatchObject({ statusCode: 401 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a token with an extra application claim', async () => {
    const token = await new SignJWT({
      email: 'smuggled@example.com',
      role: 'OBSERVER',
      sessionVersion: 4,
      type: 'observer-session',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setAudience('fluke-ios-observer')
      .setIssuer(OBSERVER_ISSUER)
      .setSubject(OBSERVER.id)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(new TextEncoder().encode(OBSERVER_SECRET));

    await expect(resolveObserverFromToken(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it.each([undefined, 'wrong-observer-issuer'])(
    'rejects a token with a missing or wrong issuer: %s',
    async (issuer) => {
      let builder = new SignJWT({
        role: 'OBSERVER',
        sessionVersion: OBSERVER.sessionVersion,
        type: 'observer-session',
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setAudience('fluke-ios-observer')
        .setSubject(OBSERVER.id)
        .setIssuedAt()
        .setExpirationTime('7d');
      if (issuer !== undefined) {
        builder = builder.setIssuer(issuer);
      }
      const token = await builder.sign(new TextEncoder().encode(OBSERVER_SECRET));

      await expect(resolveObserverFromToken(token)).rejects.toMatchObject({ statusCode: 401 });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    },
  );

  it('preserves database failures for the canonical server error boundary', async () => {
    const issued = await app.inject({ method: 'GET', url: '/issue' });
    const token = String(issued.headers['set-cookie']).split(';', 1)[0].split('=', 2)[1];
    const failure = Object.assign(new Error('database unavailable'), {
      name: 'PrismaClientKnownRequestError',
    });
    vi.mocked(prisma.user.findUnique).mockRejectedValue(failure);

    await expect(resolveObserverFromToken(token)).rejects.toBe(failure);
    expect(classifyError(failure, 'request-1')).toEqual({
      body: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'A required service is temporarily unavailable.',
        requestId: 'request-1',
        retryable: true,
      },
      kind: 'database',
      statusCode: 503,
    });
  });

  it.each([
    { ...OBSERVER_RECORD, role: 'ADMIN' as const },
    { ...OBSERVER_RECORD, sessionVersion: OBSERVER.sessionVersion + 1 },
    null,
  ])('rejects missing, role-confused, and revoked database sessions', async (record) => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(record);
    const issued = await app.inject({ method: 'GET', url: '/issue' });
    const cookieHeader = String(issued.headers['set-cookie']).split(';', 1)[0];

    const response = await app.inject({
      method: 'GET',
      url: '/required',
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(401);
  });

  it('resolves a current observer and exposes only database-backed identity', async () => {
    const issued = await app.inject({ method: 'GET', url: '/issue' });
    const cookieHeader = String(issued.headers['set-cookie']).split(';', 1)[0];

    const response = await app.inject({
      method: 'GET',
      url: '/required',
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ observer: OBSERVER });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: OBSERVER.id },
      select: {
        displayName: true,
        email: true,
        id: true,
        role: true,
        sessionVersion: true,
      },
    });
  });
});
