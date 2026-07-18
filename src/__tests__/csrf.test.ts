import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CSRF_COOKIE_NAME,
  clearObserverCookies,
  issueCsrfToken,
  requireCsrf,
} from '../lib/csrf.js';

const CSRF_SECRET = 'csrf-test-secret-material-that-is-longer-than-forty-three-characters';
const CONFIGURED_WEB_ORIGIN = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0]
  ?? 'http://localhost:5173';

function cookieValue(setCookie: string): string {
  const pair = setCookie.split(';', 1)[0];
  return pair.slice(pair.indexOf('=') + 1);
}

describe('observer CSRF', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.OBSERVER_CSRF_SECRET = CSRF_SECRET;
    app = Fastify({ logger: false });
    await app.register(cookie);
    app.get('/issue', async (_request, reply) => ({ csrfToken: issueCsrfToken(reply) }));
    app.post('/mutate', { preHandler: requireCsrf }, async () => ({ ok: true }));
    app.post('/clear', async (_request, reply) => {
      clearObserverCookies(reply);
      return { ok: true };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('issues a signed non-httpOnly host-only CSRF cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/issue' });
    const setCookie = String(response.headers['set-cookie']);
    const body = response.json<{ csrfToken: string }>();

    expect(response.statusCode).toBe(200);
    expect(body.csrfToken.length).toBeGreaterThanOrEqual(80);
    expect(setCookie).toContain(`${CSRF_COOKIE_NAME}=${body.csrfToken}`);
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api/v1');
    expect(setCookie).not.toContain('HttpOnly');
    expect(setCookie).not.toContain('Domain=');
  });

  it('requires matching valid CSRF cookie and header for mutations', async () => {
    const issued = await app.inject({ method: 'GET', url: '/issue' });
    const token = cookieValue(String(issued.headers['set-cookie']));

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: { [CSRF_COOKIE_NAME]: token },
      headers: { 'x-fluke-csrf': token },
    });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    { cookieToken: undefined, headerToken: undefined },
    { cookieToken: 'a'.repeat(87), headerToken: 'a'.repeat(87) },
    { cookieToken: 'a'.repeat(87), headerToken: 'b'.repeat(87) },
    { cookieToken: 'short', headerToken: 'short' },
    { cookieToken: `${'a'.repeat(43)}.${'b'.repeat(43)}`, headerToken: `${'a'.repeat(43)}.${'!'.repeat(43)}` },
    { cookieToken: 'a'.repeat(513), headerToken: 'a'.repeat(513) },
  ])('rejects missing, forged, mismatched, and unbounded tokens', async ({ cookieToken, headerToken }) => {
    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: cookieToken ? { [CSRF_COOKIE_NAME]: cookieToken } : undefined,
      headers: headerToken ? { 'x-fluke-csrf': headerToken } : undefined,
    });

    expect(response.statusCode).toBe(403);
  });

  it('allows native clients without Origin and exact configured web origins', async () => {
    const issued = await app.inject({ method: 'GET', url: '/issue' });
    const token = cookieValue(String(issued.headers['set-cookie']));
    const headers = { 'x-fluke-csrf': token };
    const cookies = { [CSRF_COOKIE_NAME]: token };

    const nativeResponse = await app.inject({ method: 'POST', url: '/mutate', headers, cookies });
    const webResponse = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { ...headers, origin: CONFIGURED_WEB_ORIGIN },
      cookies,
    });

    expect(nativeResponse.statusCode).toBe(200);
    expect(webResponse.statusCode).toBe(200);
  });

  it.each(['null', 'https://evil.example', 'http://localhost:5173.evil.example']) (
    'rejects an untrusted Origin before accepting a matching token: %s',
    async (origin) => {
      const issued = await app.inject({ method: 'GET', url: '/issue' });
      const token = cookieValue(String(issued.headers['set-cookie']));
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { origin, 'x-fluke-csrf': token },
        cookies: { [CSRF_COOKIE_NAME]: token },
      });

      expect(response.statusCode).toBe(403);
    },
  );

  it('clears only host-only observer cookies at their exact path', async () => {
    const response = await app.inject({ method: 'POST', url: '/clear' });
    const setCookies = response.headers['set-cookie'];
    const serialized = Array.isArray(setCookies) ? setCookies.join('\n') : String(setCookies);

    expect(serialized).toContain('fluke_observer=;');
    expect(serialized).toContain('fluke_csrf=;');
    expect(serialized).toContain('Path=/api/v1');
    expect(serialized).not.toContain('Domain=');
  });
});
