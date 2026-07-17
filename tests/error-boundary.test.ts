import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeErrorSchema } from '../src/contracts/index.js';
import type { BuildAppOptions } from '../src/app.js';

vi.mock('../src/db.js', () => ({
  prisma: {
    externalSighting: { findMany: vi.fn() },
    predictionGrid: { findUnique: vi.fn() },
    sighting: { findMany: vi.fn() },
    whale: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

const { prisma } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');

const RELEASE_A_FEATURES = Object.freeze({
  accounts: false,
  identification: false,
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

function expectSafeError(body: unknown, expected: Readonly<Record<string, unknown>>): void {
  expect(SafeErrorSchema.parse(body)).toMatchObject(expected);
}

describe('global safe error boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const appsToClose = apps;
    apps = [];
    await Promise.all(appsToClose.map((app) => app.close()));
  });

  it('propagates a safe client request ID through not-found responses', async () => {
    const app = await createApp();
    const response = await app.inject({
      headers: { 'x-request-id': 'client-request-123' },
      method: 'GET',
      url: '/missing-route',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toBe('client-request-123');
    expectSafeError(response.json(), {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      requestId: 'client-request-123',
      retryable: false,
    });
  });

  it('normalizes direct validation and authentication replies', async () => {
    const validationApp = await createApp();
    const validation = await validationApp.inject({
      headers: { 'x-request-id': 'validation-request' },
      method: 'GET',
      url: '/api/v1/predict',
    });
    expect(validation.statusCode).toBe(400);
    expectSafeError(validation.json(), {
      code: 'VALIDATION_ERROR',
      requestId: 'validation-request',
      retryable: false,
    });

    const authApp = await createApp({
      features: Object.freeze({ accounts: true, identification: false, submissions: false }),
    });
    const auth = await authApp.inject({
      headers: { 'x-request-id': 'auth-request' },
      method: 'GET',
      url: '/api/v1/auth/me',
    });
    expect(auth.statusCode).toBe(401);
    expectSafeError(auth.json(), {
      code: 'UNAUTHORIZED',
      requestId: 'auth-request',
      retryable: false,
    });
  });

  it('maps database failures without leaking connection details', async () => {
    const sensitive = 'postgresql://database-user:secret@database.internal/fluke';
    const error = Object.freeze({
      message: `Prisma failed to connect to ${sensitive}`,
      name: 'PrismaClientInitializationError',
    });
    vi.mocked(prisma.whale.findMany).mockRejectedValue(error);
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/api/v1/whales' });

    expect(response.statusCode).toBe(503);
    expectSafeError(response.json(), {
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
    });
    expect(response.body).not.toContain('database-user');
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('database.internal');
  });

  it('maps provider and unexpected failures without leaking diagnostics', async () => {
    const providerError = Object.freeze({
      message: 'provider token sk-sensitive-provider-token',
      name: 'ProviderError',
    });
    vi.mocked(prisma.whale.findMany).mockRejectedValueOnce(providerError);
    const providerApp = await createApp();
    const provider = await providerApp.inject({ method: 'GET', url: '/api/v1/whales' });
    expect(provider.statusCode).toBe(503);
    expectSafeError(provider.json(), {
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
    });
    expect(provider.body).not.toContain('sk-sensitive-provider-token');

    vi.mocked(prisma.whale.findMany).mockRejectedValueOnce(
      new Error('unexpected secret diagnostic'),
    );
    const unexpectedApp = await createApp();
    const unexpected = await unexpectedApp.inject({ method: 'GET', url: '/api/v1/whales' });
    expect(unexpected.statusCode).toBe(500);
    expectSafeError(unexpected.json(), {
      code: 'INTERNAL_ERROR',
      retryable: false,
    });
    expect(unexpected.body).not.toContain('unexpected secret diagnostic');
  });

  it('returns the canonical retryable envelope when the public read limit is exceeded', async () => {
    const app = await createApp({ publicReadRateLimitMax: 2 });

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/capabilities' }),
      app.inject({ method: 'GET', url: '/api/v1/capabilities' }),
      app.inject({ method: 'GET', url: '/api/v1/capabilities' }),
    ]);
    const limited = responses.find((response) => response.statusCode === 429);

    expect(limited).toBeDefined();
    expectSafeError(limited?.json(), {
      code: 'RATE_LIMITED',
      retryable: true,
    });
  });
});
