import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';

vi.mock('../db.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    whale: { findMany: vi.fn(), findUnique: vi.fn() },
    sighting: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    sightingWhale: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

const TEST_USER = {
  appleRefreshTokenCiphertext: null,
  appleSub: null,
  id: 'admin-uuid',
  displayName: null,
  email: 'admin@example.com',
  passwordHash: '', // populated in beforeAll
  role: 'ADMIN' as const,
  sessionVersion: 1,
  createdAt: new Date(),
};

const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  DIRECT_URL: 'postgresql://test:test@localhost:5432/test',
  JWT_SECRET: 'x'.repeat(32),
};

describe('API environment', () => {
  it('rejects an empty JWT secret', () => {
    expect(() => parseEnv({ ...VALID_ENV, JWT_SECRET: '' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a short JWT secret', () => {
    expect(() => parseEnv({ ...VALID_ENV, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});

describe('auth routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    TEST_USER.passwordHash = await bcrypt.hash('correct-horse-battery-staple', 10);
    app = await buildApp({ silent: true, trustProxy: 1 });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/v1/auth/login', () => {
    it('rejects invalid request bodies', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'not-an-email', password: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 401 when the user does not exist', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'unknown@example.com', password: 'whatever' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when the password does not match', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(TEST_USER);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: TEST_USER.email, password: 'wrong-password' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 401 for a passwordless observer identity', async () => {
      const compare = vi.spyOn(bcrypt, 'compare');
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...TEST_USER,
        appleSub: 'apple-observer-sub',
        email: null,
        passwordHash: null,
        role: 'OBSERVER',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'observer@example.com', password: 'not-an-admin-password' },
      });

      expect(response.statusCode).toBe(401);
      expect(compare).not.toHaveBeenCalled();
    });

    it('returns 401 without an admin cookie for an observer with a password', async () => {
      const compare = vi.spyOn(bcrypt, 'compare');
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...TEST_USER,
        appleSub: 'apple-observer-with-password-sub',
        role: 'OBSERVER',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': '198.51.100.41' },
        payload: { email: TEST_USER.email, password: 'correct-horse-battery-staple' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(compare).not.toHaveBeenCalled();
    });

    it('sets a signed admin cookie on successful login', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(TEST_USER);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': '198.51.100.40' },
        payload: { email: TEST_USER.email, password: 'correct-horse-battery-staple' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        email: TEST_USER.email,
        role: 'ADMIN',
      });

      const setCookie = response.headers['set-cookie'];
      const cookieValue = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie ?? '';
      expect(cookieValue).toContain('fluke_admin=');
      expect(cookieValue.toLowerCase()).toContain('httponly');
      expect(cookieValue.toLowerCase()).toContain('samesite=lax');
    });

    it('rate limits repeated admin login attempts', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const responses = await Promise.all(Array.from({ length: 6 }, () => app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': '198.51.100.42' },
        payload: { email: 'unknown@example.com', password: 'whatever' },
      })));

      expect(responses.map((response) => response.statusCode)).toContain(429);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('returns 401 without a valid cookie', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(response.statusCode).toBe(401);
    });

    it('returns the admin claims when the cookie is valid', async () => {
      const token = app.jwt.sign(
        { userId: TEST_USER.id, email: TEST_USER.email, role: TEST_USER.role },
        { expiresIn: '7d' },
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: { fluke_admin: token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ userId: string; email: string; role: string }>();
      expect(body.userId).toBe(TEST_USER.id);
      expect(body.email).toBe(TEST_USER.email);
      expect(body.role).toBe('ADMIN');
    });

    it('rejects a validly signed observer token on admin routes', async () => {
      const token = app.jwt.sign(
        { userId: 'observer-uuid', email: 'observer@example.com', role: 'OBSERVER' },
        { expiresIn: '7d' },
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: { fluke_admin: token },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('clears the admin cookie', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });

      expect(response.statusCode).toBe(200);
      const setCookie = response.headers['set-cookie'];
      const cookieValue = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie ?? '';
      // Clearing sets the cookie with an Expires in the past or Max-Age=0.
      expect(cookieValue.toLowerCase()).toMatch(/(expires=thu, 01 jan 1970|max-age=0)/);
    });
  });
});
