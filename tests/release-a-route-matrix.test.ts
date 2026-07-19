import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const observerAuth = Object.freeze({
  appleAuth: Object.freeze({
    exchangeAppleAuthorizationCode: async () => { throw new Error('unused'); },
    revokeAppleRefreshToken: async () => { throw new Error('unused'); },
    verifyAppleIdentityToken: async () => { throw new Error('unused'); },
  }),
  storage: Object.freeze({
    publicUrl: () => { throw new Error('unused'); },
    put: async () => { throw new Error('unused'); },
    remove: async () => { throw new Error('unused'); },
  }),
  tokenCrypto: Object.freeze({
    decryptToken: () => { throw new Error('unused'); },
    encryptToken: () => { throw new Error('unused'); },
  }),
});

const RELEASE_A_FEATURES = Object.freeze({
  accounts: false,
  identification: false,
  identificationMode: 'disabled' as const,
  submissions: false,
});

const FEATURE_ROUTE_CASES = [
  {
    name: 'all disabled',
    features: RELEASE_A_FEATURES,
    expected: Object.freeze({
      accountRoute: false,
      logbookRoute: false,
      observerAuthRoute: false,
      identifyRoute: false,
      releaseRoute: false,
      photoAdminRoute: false,
      photoSubmissionRoute: false,
      staticUploadsRoute: false,
      submissionRoute: false,
    }),
  },
  {
    name: 'accounts only',
    features: Object.freeze({
      accounts: true, identification: false, identificationMode: 'disabled' as const,
      submissions: false,
    }),
    expected: Object.freeze({
      accountRoute: true,
      logbookRoute: true,
      observerAuthRoute: true,
      identifyRoute: false,
      releaseRoute: false,
      photoAdminRoute: true,
      photoSubmissionRoute: false,
      staticUploadsRoute: false,
      submissionRoute: false,
    }),
  },
  {
    name: 'identification only',
    features: Object.freeze({
      accounts: false, identification: true, identificationMode: 'server' as const,
      submissions: false,
    }),
    expected: Object.freeze({
      accountRoute: false,
      logbookRoute: false,
      observerAuthRoute: false,
      identifyRoute: true,
      releaseRoute: true,
      photoAdminRoute: false,
      photoSubmissionRoute: false,
      staticUploadsRoute: false,
      submissionRoute: false,
    }),
  },
  {
    name: 'submissions only',
    features: Object.freeze({
      accounts: false, identification: false, identificationMode: 'disabled' as const,
      submissions: true,
    }),
    expected: Object.freeze({
      accountRoute: false,
      logbookRoute: false,
      observerAuthRoute: false,
      identifyRoute: false,
      releaseRoute: false,
      photoAdminRoute: false,
      photoSubmissionRoute: true,
      staticUploadsRoute: true,
      submissionRoute: true,
    }),
  },
  {
    name: 'accounts and identification',
    features: Object.freeze({
      accounts: true, identification: true, identificationMode: 'server' as const,
      submissions: false,
    }),
    expected: Object.freeze({
      accountRoute: true,
      logbookRoute: true,
      observerAuthRoute: true,
      identifyRoute: true,
      releaseRoute: true,
      photoAdminRoute: true,
      photoSubmissionRoute: false,
      staticUploadsRoute: false,
      submissionRoute: false,
    }),
  },
  {
    name: 'accounts and submissions',
    features: Object.freeze({
      accounts: true, identification: false, identificationMode: 'disabled' as const,
      submissions: true,
    }),
    expected: Object.freeze({
      accountRoute: true,
      logbookRoute: true,
      observerAuthRoute: true,
      identifyRoute: false,
      releaseRoute: false,
      photoAdminRoute: true,
      photoSubmissionRoute: true,
      staticUploadsRoute: true,
      submissionRoute: true,
    }),
  },
  {
    name: 'identification and submissions',
    features: Object.freeze({
      accounts: false, identification: true, identificationMode: 'server' as const,
      submissions: true,
    }),
    expected: Object.freeze({
      accountRoute: false,
      logbookRoute: false,
      observerAuthRoute: false,
      identifyRoute: true,
      releaseRoute: true,
      photoAdminRoute: false,
      photoSubmissionRoute: true,
      staticUploadsRoute: true,
      submissionRoute: true,
    }),
  },
  {
    name: 'all enabled',
    features: Object.freeze({
      accounts: true, identification: true, identificationMode: 'server' as const,
      submissions: true,
    }),
    expected: Object.freeze({
      accountRoute: true,
      logbookRoute: true,
      observerAuthRoute: true,
      identifyRoute: true,
      releaseRoute: true,
      photoAdminRoute: true,
      photoSubmissionRoute: true,
      staticUploadsRoute: true,
      submissionRoute: true,
    }),
  },
  {
    name: 'on-device identification and submissions',
    features: Object.freeze({
      accounts: false, identification: true, identificationMode: 'on-device' as const,
      submissions: true,
    }),
    expected: Object.freeze({
      accountRoute: false,
      logbookRoute: false,
      observerAuthRoute: false,
      identifyRoute: false,
      releaseRoute: true,
      photoAdminRoute: false,
      photoSubmissionRoute: true,
      staticUploadsRoute: true,
      submissionRoute: true,
    }),
  },
] as const;

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
    ['GET', '/api/v1/identifier/releases/current'],
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
    ['/api/v1/whales/:id'],
    ['/api/v1/whales/:id/track'],
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

describe.each(FEATURE_ROUTE_CASES)('Release feature route ownership: $name', ({
  expected,
  features,
}) => {
  it('registers only routes owned by the enabled feature', async () => {
    const app = await buildApp({
      features,
      ...(features.accounts ? { observerAuth } : {}),
      silent: true,
    });

    try {
      await app.ready();

      expect(app.hasRoute({ method: 'POST', url: '/api/v1/auth/login' }))
        .toBe(expected.accountRoute);
      expect(app.hasRoute({ method: 'POST', url: '/api/v1/auth/apple' }))
        .toBe(expected.observerAuthRoute);
      expect(app.hasRoute({ method: 'GET', url: '/api/v1/auth/me' }))
        .toBe(expected.observerAuthRoute);
      expect(app.hasRoute({ method: 'POST', url: '/api/v1/auth/logout' }))
        .toBe(expected.observerAuthRoute);
      expect(app.hasRoute({ method: 'DELETE', url: '/api/v1/auth/account' }))
        .toBe(expected.observerAuthRoute);
      expect(app.hasRoute({ method: 'GET', url: '/api/v1/sightings/me' }))
        .toBe(expected.logbookRoute);
      expect(app.hasRoute({ method: 'GET', url: '/api/v1/admin/sightings' }))
        .toBe(expected.accountRoute);
      expect(app.hasRoute({ method: 'POST', url: '/api/v1/identify' }))
        .toBe(expected.identifyRoute);
      if (!expected.identifyRoute) {
        const identify = await app.inject({ method: 'POST', url: '/api/v1/identify' });
        expect(identify.statusCode).toBe(404);
      }
      expect(app.hasRoute({ method: 'GET', url: '/api/v1/identifier/releases/current' }))
        .toBe(expected.releaseRoute);
      expect(app.hasRoute({ method: 'GET', url: '/api/v1/sightings/:id/photos' }))
        .toBe(expected.photoAdminRoute);
      expect(app.hasRoute({ method: 'GET', url: '/api/v1/media/:photoId' }))
        .toBe(expected.photoAdminRoute || expected.photoSubmissionRoute);
      expect(app.hasRoute({ method: 'POST', url: '/api/v1/sightings/:id/photos' }))
        .toBe(expected.photoSubmissionRoute);
      expect(app.hasRoute({ method: 'GET', url: '/uploads/*' }))
        .toBe(expected.staticUploadsRoute);
      expect(app.hasRoute({ method: 'POST', url: '/api/v1/sightings' }))
        .toBe(expected.submissionRoute);

      const capabilities = await app.inject({
        method: 'GET',
        url: '/api/v1/capabilities',
      });
      expect(capabilities.json()).toEqual(features);
    } finally {
      await app.close();
    }
  });
});
