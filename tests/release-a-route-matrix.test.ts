import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const RELEASE_A_FEATURES = Object.freeze({
  accounts: false,
  identification: false,
  submissions: false,
});

describe('Release A route firewall', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      features: RELEASE_A_FEATURES,
      silent: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['POST', '/api/v1/sightings'],
    ['PUT', '/api/v1/sightings/sighting-1'],
    ['PATCH', '/api/v1/sightings/sighting-1'],
    ['DELETE', '/api/v1/sightings/sighting-1'],
    ['POST', '/api/v1/sightings/sighting-1/photos'],
    ['GET', '/api/v1/sightings/sighting-1/photos'],
    ['GET', '/uploads/example.webp'],
    ['POST', '/api/v1/identify'],
    ['POST', '/api/v1/auth/login'],
    ['GET', '/api/v1/auth/me'],
    ['GET', '/api/v1/admin/sightings'],
  ] as const)('returns 404 for disabled %s %s', async (method, url) => {
    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(404);
  });

  it.each([
    ['/api/v1/health'],
    ['/api/v1/ready'],
    ['/api/v1/capabilities'],
    ['/api/v1/whales'],
    ['/api/v1/whales/:catalogId'],
    ['/api/v1/sightings'],
    ['/api/v1/sightings/historical'],
    ['/api/v1/external-sightings'],
    ['/api/v1/predict'],
  ] as const)('keeps the Release A GET route registered at %s', (url) => {
    expect(app.hasRoute({ method: 'GET', url })).toBe(true);
  });

  it('reports the exact disabled feature set from the same app configuration', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/capabilities',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(RELEASE_A_FEATURES);
  });
});
