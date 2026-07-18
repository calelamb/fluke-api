import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    auditLog: { deleteMany: vi.fn() },
    sighting: { deleteMany: vi.fn(), updateMany: vi.fn() },
    sightingPhoto: { findMany: vi.fn() },
    submissionIdempotency: { deleteMany: vi.fn() },
    user: {
      create: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    whale: { findMany: vi.fn(), findUnique: vi.fn() },
    sightingWhale: { upsert: vi.fn() },
  },
}));

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');
const { logCleanupFailure } = await import('../routes/observer-auth.js');

const appleAuth = Object.freeze({
  exchangeAppleAuthorizationCode: vi.fn(),
  revokeAppleRefreshToken: vi.fn(),
  verifyAppleIdentityToken: vi.fn(),
});
const tokenCrypto = Object.freeze({
  decryptToken: vi.fn(),
  encryptToken: vi.fn(),
});
const storage = Object.freeze({
  publicUrl: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
});

const validAppleRequest = Object.freeze({
  authorizationCode: 'single-use-code',
  fullName: 'Salish Sea Observer',
  identityToken: 'header.payload.signature',
  nonce: 'n'.repeat(43),
});
const observer = Object.freeze({
  appleRefreshTokenCiphertext: 'encrypted-refresh',
  appleSub: 'apple-subject-1',
  createdAt: new Date('2026-07-17T00:00:00.000Z'),
  displayName: 'Salish Sea Observer',
  email: 'observer@example.com',
  id: 'observer-1',
  passwordHash: null,
  role: 'OBSERVER' as const,
  sessionVersion: 1,
});

function cookieMap(response: { headers: Record<string, unknown> }): Record<string, string> {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : [String(header ?? '')];
  return Object.fromEntries(values.map((value) => {
    const [pair] = value.split(';', 1);
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

describe('observer account routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.OBSERVER_JWT_SECRET = 'observer-test-secret-material-that-is-longer-than-43-characters';
    process.env.OBSERVER_CSRF_SECRET = 'csrf-test-secret-material-that-is-longer-than-forty-three-characters';
    app = await buildApp({
      observerAuth: { appleAuth, storage, tokenCrypto },
      silent: true,
      trustProxy: 1,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => (
      callback(prisma as never)
    ) as never);
    vi.mocked(appleAuth.verifyAppleIdentityToken).mockResolvedValue({
      email: observer.email,
      emailVerified: true,
      subject: observer.appleSub,
    });
    vi.mocked(appleAuth.exchangeAppleAuthorizationCode).mockResolvedValue({
      accessToken: 'access-token',
      expiresIn: 3600,
      identityToken: 'apple-endpoint-token',
      refreshToken: 'refresh-token',
      subject: observer.appleSub,
    });
    vi.mocked(tokenCrypto.encryptToken).mockReturnValue('encrypted-refresh');
    vi.mocked(tokenCrypto.decryptToken).mockReturnValue('refresh-token');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.create).mockResolvedValue(observer as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.sightingPhoto.findMany).mockResolvedValue([] as never);
  });

  it('creates the first observer transactionally with encrypted refresh token and isolated cookies', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.10' },
      payload: validAppleRequest,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      csrfToken: expect.any(String),
      user: {
        displayName: observer.displayName,
        email: observer.email,
        id: observer.id,
        role: 'OBSERVER',
      },
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        appleRefreshTokenCiphertext: 'encrypted-refresh',
        appleSub: observer.appleSub,
        displayName: observer.displayName,
        email: observer.email,
        passwordHash: null,
        role: 'OBSERVER',
        sessionVersion: 1,
      },
    });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('fluke_observer=');
    expect(setCookie).toContain('fluke_csrf=');
    expect(setCookie).not.toContain('fluke_admin=');
  });

  it('updates repeat sign-in without overwriting the first non-null name', async () => {
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(observer as never)
      .mockResolvedValueOnce(observer as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...observer,
      email: 'new-relay@example.com',
    } as never);
    vi.mocked(appleAuth.verifyAppleIdentityToken).mockResolvedValue({
      email: 'NEW-RELAY@example.com',
      emailVerified: true,
      subject: observer.appleSub,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.11' },
      payload: { ...validAppleRequest, fullName: 'Replacement Name' },
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      data: {
        appleRefreshTokenCiphertext: 'encrypted-refresh',
        email: 'new-relay@example.com',
      },
      where: { id: observer.id },
    });
  });

  it('accepts an Apple identity with no email and preserves a null email', async () => {
    vi.mocked(appleAuth.verifyAppleIdentityToken).mockResolvedValue({ subject: observer.appleSub });
    vi.mocked(prisma.user.create).mockResolvedValue({ ...observer, email: null } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.12' },
      payload: validAppleRequest,
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: null }),
    }));
  });

  it('does not trust an unverified email claim', async () => {
    vi.mocked(appleAuth.verifyAppleIdentityToken).mockResolvedValue({
      email: 'unverified@example.com',
      emailVerified: false,
      subject: observer.appleSub,
    });
    vi.mocked(prisma.user.create).mockResolvedValue({ ...observer, email: null } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.19' },
      payload: validAppleRequest,
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: null }),
    }));
  });

  it('does not link an Apple subject to an existing email-only account', async () => {
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...observer, appleSub: null, role: 'ADMIN' } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.13' },
      payload: validAppleRequest,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('CONFLICT');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid token', 'APPLE_TOKEN_INVALID', 401],
    ['provider failure', 'APPLE_UPSTREAM_UNAVAILABLE', 503],
  ] as const)('maps %s to a safe response without credential disclosure', async (_label, code, status) => {
    vi.mocked(appleAuth.verifyAppleIdentityToken).mockRejectedValue(
      Object.assign(new Error('sanitized'), { code }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.14' },
      payload: validAppleRequest,
    });

    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain(validAppleRequest.identityToken);
    expect(response.body).not.toContain(validAppleRequest.authorizationCode);
  });

  it('rejects identity/code subject mismatch without writing an account', async () => {
    vi.mocked(appleAuth.exchangeAppleAuthorizationCode).mockResolvedValue({
      accessToken: 'access-token',
      expiresIn: 3600,
      identityToken: 'endpoint-token',
      refreshToken: 'refresh-token',
      subject: 'different-subject',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.15' },
      payload: validAppleRequest,
    });

    expect(response.statusCode).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('maps a transactional uniqueness race to a canonical conflict', async () => {
    vi.mocked(prisma.user.create).mockRejectedValue(Object.assign(new Error('unique'), {
      code: 'P2002',
      name: 'PrismaClientKnownRequestError',
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.20' },
      payload: validAppleRequest,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('CONFLICT');
  });

  it('keeps admin /me and logout behavior compatible under observer composition', async () => {
    const token = app.jwt.sign({
      email: 'admin@example.com',
      role: 'ADMIN',
      userId: 'admin-1',
    }, { expiresIn: '7d' });
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { fluke_admin: token },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      email: 'admin@example.com',
      role: 'ADMIN',
      userId: 'admin-1',
    });

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { fluke_admin: token },
    });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie'])).toContain('fluke_admin=;');
  });

  it('rate limits Apple sign-in to ten attempts per source IP per hour', async () => {
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await app.inject({
        method: 'POST',
        url: '/api/v1/auth/apple',
        headers: { 'x-forwarded-for': '198.51.100.21' },
        payload: validAppleRequest,
      }));
    }

    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
  });

  it('returns observer-compatible /me and logs out only with CSRF', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.16' },
      payload: validAppleRequest,
    });
    const cookies = cookieMap(login);
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(observer as never);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      displayName: observer.displayName,
      email: observer.email,
      id: observer.id,
      role: 'OBSERVER',
      userId: observer.id,
    });

    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', cookies });
    expect(noCsrf.statusCode).toBe(403);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies,
      headers: { 'x-fluke-csrf': cookies.fluke_csrf ?? '' },
    });
    expect(logout.statusCode).toBe(200);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      data: { sessionVersion: { increment: 1 } },
      where: { id: observer.id, role: 'OBSERVER', sessionVersion: observer.sessionVersion },
    });
    expect(String(logout.headers['set-cookie'])).toContain('fluke_observer=;');
  });

  it('requires fresh matching Apple reauthentication before deletion', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.17' },
      payload: validAppleRequest,
    });
    const cookies = cookieMap(login);
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(observer as never);
    vi.mocked(appleAuth.verifyAppleIdentityToken).mockResolvedValue({ subject: 'different-subject' });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/account',
      cookies,
      headers: { 'x-fluke-csrf': cookies.fluke_csrf ?? '' },
      payload: {
        authorizationCode: 'fresh-code',
        identityToken: 'fresh-token',
        nonce: 'f'.repeat(43),
      },
    });

    expect(response.statusCode).toBe(401);
    expect(appleAuth.revokeAppleRefreshToken).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('revokes and deletes the account after fresh matching Apple reauthentication', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      headers: { 'x-forwarded-for': '198.51.100.18' },
      payload: validAppleRequest,
    });
    const cookies = cookieMap(login);
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(observer as never);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/account',
      cookies,
      headers: { 'x-fluke-csrf': cookies.fluke_csrf ?? '' },
      payload: {
        authorizationCode: 'fresh-code',
        identityToken: 'fresh-token',
        nonce: 'f'.repeat(43),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(appleAuth.revokeAppleRefreshToken).toHaveBeenCalled();
    expect(prisma.user.delete).toHaveBeenCalled();
    expect(String(response.headers['set-cookie'])).toContain('fluke_observer=;');
  });
});

describe('observer cleanup diagnostics', () => {
  it('logs only bounded non-sensitive cleanup fields', () => {
    const error = vi.fn();
    const privateStorageKey = 'observers/private-user/sighting-secret.webp';
    const privateFailureText = 'observer@example.com refresh-token-value';

    logCleanupFailure({ error }, 'request-safe-1', {
      attempts: 3,
      error: new Error(privateFailureText),
      storageKey: privateStorageKey,
    });

    const serializedLogs = JSON.stringify(error.mock.calls);
    expect(error).toHaveBeenCalledWith({
      attempts: 3,
      failureKind: 'storage-cleanup',
      requestId: 'request-safe-1',
    }, 'account object cleanup failed');
    expect(serializedLogs).not.toContain(privateStorageKey);
    expect(serializedLogs).not.toContain('observer@example.com');
    expect(serializedLogs).not.toContain('refresh-token-value');
  });
});
