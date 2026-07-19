import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildAppOptions } from '../src/app.js';

vi.mock('../src/db.js', () => {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ set_config: '5000ms' }]),
    externalSighting: { findMany: vi.fn() },
    predictionGrid: { findUnique: vi.fn() },
    sighting: { findMany: vi.fn() },
    whale: { findMany: vi.fn(), findUnique: vi.fn() },
  };
  return {
    prisma: {
      ...transaction,
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction)),
    },
  };
});

const { prisma } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');

const RELEASE_A_FEATURES = Object.freeze({
  accounts: false,
  identification: false,
  identificationMode: 'disabled' as const,
  submissions: false,
});
let apps: readonly Awaited<ReturnType<typeof buildApp>>[] = [];

async function createApp(options: BuildAppOptions = {}) {
  const app = await buildApp({
    features: RELEASE_A_FEATURES,
    silent: true,
    ...options,
  });
  apps = [...apps, app];
  return app;
}

describe('HTTP production hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const appsToClose = apps;
    apps = [];
    await Promise.all(appsToClose.map((app) => app.close()));
  });

  it('adds maintained security headers to API responses', async () => {
    const app = await createApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
    expect(response.headers['referrer-policy']).toBeDefined();
  });

  it('compresses sufficiently large public JSON responses', async () => {
    vi.mocked(prisma.whale.findMany).mockResolvedValue([{
      biography: 'x'.repeat(4_000),
      birthYear: 1990,
      catalogId: 'TEST-001',
      deathYear: null,
      distinguishingMarks: null,
      ecotype: 'UNKNOWN',
      heroImageUrl: null,
      id: 'whale-1',
      name: 'Test Whale',
      notableEvents: [],
      pod: null,
      sex: 'UNKNOWN',
      sourceCitations: [],
      status: 'ALIVE',
    }]);
    const app = await createApp();

    const response = await app.inject({
      headers: { 'accept-encoding': 'gzip' },
      method: 'GET',
      url: '/api/v1/whales',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.rawPayload.byteLength).toBeLessThan(4_000);
  });

  it('trusts exactly one configured Railway proxy hop', async () => {
    const app = await createApp({ trustProxy: 1 });
    app.get('/test/request-ip', async (request) => ({ ip: request.ip }));

    const response = await app.inject({
      headers: { 'x-forwarded-for': '203.0.113.8, 10.0.0.4' },
      method: 'GET',
      url: '/test/request-ip',
    });

    expect(response.json()).toEqual({ ip: '10.0.0.4' });
  });

  it('keeps identification unregistered and never reflects supplied credentials', async () => {
    const app = await createApp();
    const credential = 'Bearer private-observer-credential-material';

    const response = await app.inject({
      headers: {
        authorization: credential,
        cookie: 'fluke_observer=malformed-private-session',
      },
      method: 'POST',
      payload: { image: 'private-image-data' },
      url: '/api/v1/identify',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
    expect(response.body).not.toContain(credential);
    expect(response.body).not.toContain('malformed-private-session');
    expect(response.body).not.toContain('private-image-data');
  });
});
