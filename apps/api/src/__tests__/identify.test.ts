import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

describe('POST /api/v1/identify', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ silent: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 501 with a phase-2 explanation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/identify',
      payload: {},
    });

    expect(response.statusCode).toBe(501);
    expect(response.json<{ error: string }>().error).toMatch(/Phase 2/i);
  });
});
