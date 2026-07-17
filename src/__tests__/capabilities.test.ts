import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilitiesSchema } from '../contracts/index.js';
import { buildApp } from '../app.js';

describe('GET /api/v1/capabilities', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      features: {
        accounts: false,
        identification: false,
        submissions: false,
      },
      silent: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the disabled Release A capability set', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/capabilities',
    });

    expect(response.statusCode).toBe(200);
    expect(CapabilitiesSchema.parse(response.json())).toEqual({
      accounts: false,
      identification: false,
      submissions: false,
    });
  });
});
