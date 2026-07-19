import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

describe('GET /api/v1/health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ silent: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok status with a timestamp', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; timestamp: string }>();
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('does not call the readiness probe for liveness', async () => {
    const readinessProbe = vi.fn(async () => undefined);
    const isolatedApp = await buildApp({ readinessProbe, silent: true });

    try {
      const response = await isolatedApp.inject({ method: 'GET', url: '/api/v1/health' });

      expect(response.statusCode).toBe(200);
      expect(readinessProbe).not.toHaveBeenCalled();
    } finally {
      await isolatedApp.close();
    }
  });
});

describe('GET /api/v1/ready', () => {
  it('returns ready when the database probe succeeds', async () => {
    const readinessProbe = vi.fn(async () => undefined);
    const app = await buildApp({ readinessProbe, silent: true });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ready' });
      expect(readinessProbe).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('returns a safe unready response when the database probe fails', async () => {
    const readinessProbe = vi.fn(async () => {
      throw new Error('postgresql://database-user:secret@database.internal/fluke');
    });
    const app = await buildApp({ readinessProbe, silent: true });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'A required service is temporarily unavailable.',
        requestId: expect.any(String),
        retryable: true,
      });
      expect(response.body).not.toContain('database-user');
      expect(response.body).not.toContain('secret');
    } finally {
      await app.close();
    }
  });

  it('keeps on-device mode unready without one certified ACTIVE release', async () => {
    const readinessProbe = vi.fn(async () => undefined);
    const activeRelease = vi.fn(async () => false);
    const feed = vi.fn(async () => undefined);
    const submission = vi.fn(async () => undefined);
    const app = await buildApp({
      features: {
        accounts: false,
        identification: true,
        identificationMode: 'on-device',
        submissions: true,
      },
      onDeviceReadinessProbes: { activeRelease, feed, submission },
      readinessProbe,
      silent: true,
    });

    try {
      const readiness = await app.inject({ method: 'GET', url: '/api/v1/ready' });
      const capabilities = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });

      expect(readiness.statusCode).toBe(503);
      expect(capabilities.json()).toMatchObject({
        identification: true,
        identificationMode: 'on-device',
      });
      expect(readinessProbe).toHaveBeenCalledOnce();
      expect(activeRelease).toHaveBeenCalledOnce();
      expect(feed).not.toHaveBeenCalled();
      expect(submission).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('requires healthy release, feed, and submission probes for on-device readiness', async () => {
    const readinessProbe = vi.fn(async () => undefined);
    const activeRelease = vi.fn(async () => true);
    const feed = vi.fn(async () => undefined);
    const submission = vi.fn(async () => undefined);
    const app = await buildApp({
      features: {
        accounts: false,
        identification: true,
        identificationMode: 'on-device',
        submissions: true,
      },
      onDeviceReadinessProbes: { activeRelease, feed, submission },
      readinessProbe,
      silent: true,
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ready' });
      expect(readinessProbe).toHaveBeenCalledOnce();
      expect(activeRelease).toHaveBeenCalledOnce();
      expect(feed).toHaveBeenCalledOnce();
      expect(submission).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each(['feed', 'submission'] as const)(
    'fails on-device readiness when the %s dependency is unhealthy',
    async (failedProbe) => {
      const healthy = vi.fn(async () => undefined);
      const unhealthy = vi.fn(async () => { throw new Error(`${failedProbe} unavailable`); });
      const app = await buildApp({
        features: {
          accounts: false,
          identification: true,
          identificationMode: 'on-device',
          submissions: true,
        },
        onDeviceReadinessProbes: {
          activeRelease: async () => true,
          feed: failedProbe === 'feed' ? unhealthy : healthy,
          submission: failedProbe === 'submission' ? unhealthy : healthy,
        },
        readinessProbe: async () => undefined,
        silent: true,
      });

      try {
        const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });

        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain(`${failedProbe} unavailable`);
        expect(unhealthy).toHaveBeenCalledOnce();
      } finally {
        await app.close();
      }
    },
  );
});
