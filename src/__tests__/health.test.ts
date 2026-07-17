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
      expect(response.json()).toEqual({ status: 'unready' });
      expect(response.body).not.toContain('database-user');
      expect(response.body).not.toContain('secret');
    } finally {
      await app.close();
    }
  });
});
