import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const transaction = {
  $queryRaw: vi.fn().mockResolvedValue([{ set_config: '5000ms' }]),
  auditLog: { create: vi.fn() },
  identifierRelease: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  whale: { findMany: vi.fn() },
};

vi.mock('../db.js', () => ({
  prisma: {
    ...transaction,
    $transaction: vi.fn(async (operation: (client: typeof transaction) => unknown) =>
      operation(transaction)),
  },
}));

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

const CSRF_SECRET = 'identifier-release-test-secret-that-is-longer-than-forty-three-characters';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const ADMIN = Object.freeze({
  email: 'admin@example.invalid', role: 'ADMIN' as const, userId: 'admin-id',
});
const MODERATOR = Object.freeze({
  email: 'moderator@example.invalid', role: 'MODERATOR' as const, userId: 'moderator-id',
});
const inventory = Object.freeze([
  Object.freeze({ catalogId: 'J35', referencePhotoId: 'reference-j35-left' }),
]);
const activeRelease = Object.freeze({
  catalogInventory: inventory,
  indexVersion: 'index-v2',
  manifestVersion: 'manifest-v2',
  modelId: 'miewid',
  modelVersion: 'model-v2',
  publishedAt: new Date('2026-07-18T12:00:00.000Z'),
  revokedAt: null,
  rightsAttestationDigest: DIGEST,
  scoreSemantics: 'uncalibrated_similarity_not_probability',
  sequence: 2n,
  status: 'ACTIVE' as const,
  suggestionsAcceptedUntil: new Date('2026-08-18T12:00:00.000Z'),
});
const registration = Object.freeze({
  catalogInventory: inventory,
  indexVersion: activeRelease.indexVersion,
  manifestVersion: activeRelease.manifestVersion,
  modelId: activeRelease.modelId,
  modelVersion: activeRelease.modelVersion,
  publishedAt: activeRelease.publishedAt.toISOString(),
  rightsAttestationDigest: DIGEST,
  scoreSemantics: activeRelease.scoreSemantics,
  sequence: 2,
  suggestionsAcceptedUntil: activeRelease.suggestionsAcceptedUntil.toISOString(),
});

function prismaRace(code: 'P2002' | 'P2034'): Error & { readonly code: string } {
  return Object.assign(new Error('simulated transaction race'), { code });
}

function csrfToken(): string {
  const raw = 'r'.repeat(43);
  const signature = createHmac('sha256', CSRF_SECRET).update(raw).digest('base64url');
  return `${raw}.${signature}`;
}

describe('identifier release routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let moderatorToken: string;

  beforeAll(async () => {
    process.env.OBSERVER_CSRF_SECRET = CSRF_SECRET;
    app = await buildApp({ silent: true });
    await app.ready();
    adminToken = app.jwt.sign(ADMIN);
    moderatorToken = app.jwt.sign(MODERATOR);
  });

  afterAll(async () => app.close());

  beforeEach(() => vi.clearAllMocks());

  it('returns only strict bounded metadata for the active release', async () => {
    vi.mocked(prisma.identifierRelease.findFirst).mockResolvedValue(activeRelease as never);

    const response = await app.inject({
      method: 'GET', url: '/api/v1/identifier/releases/current',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      indexVersion: 'index-v2',
      manifestVersion: 'manifest-v2',
      modelVersion: 'model-v2',
      publishedAt: '2026-07-18T12:00:00.000Z',
      scoreSemantics: 'uncalibrated_similarity_not_probability',
      suggestionsAcceptedUntil: '2026-08-18T12:00:00.000Z',
    });
    expect(response.body).not.toContain('catalogInventory');
    expect(response.body).not.toContain(DIGEST);
  });

  it('never exposes revoked release metadata as current', async () => {
    vi.mocked(prisma.identifierRelease.findFirst).mockResolvedValue(null);
    const response = await app.inject({
      method: 'GET', url: '/api/v1/identifier/releases/current',
    });
    expect(response.statusCode).toBe(404);
    expect(prisma.identifierRelease.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'ACTIVE' },
    }));
  });

  it('requires an administrator and CSRF for release registration', async () => {
    const anonymous = await app.inject({
      method: 'POST', payload: registration, url: '/api/v1/admin/identifier/releases/accept',
    });
    const wrongRole = await app.inject({
      cookies: { fluke_admin: moderatorToken }, method: 'POST', payload: registration,
      url: '/api/v1/admin/identifier/releases/accept',
    });
    const noCsrf = await app.inject({
      cookies: { fluke_admin: adminToken }, method: 'POST', payload: registration,
      url: '/api/v1/admin/identifier/releases/accept',
    });
    expect(anonymous.statusCode).toBe(401);
    expect(wrongRole.statusCode).toBe(403);
    expect(noCsrf.statusCode).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('validates inventory, demotes ACTIVE, inserts once, activates, and audits atomically', async () => {
    const token = csrfToken();
    transaction.identifierRelease.findUnique.mockResolvedValue(null);
    transaction.identifierRelease.findFirst.mockResolvedValueOnce({ sequence: 1n });
    transaction.whale.findMany.mockResolvedValue([{ catalogId: 'J35', id: 'whale-j35' }]);
    transaction.identifierRelease.updateMany.mockResolvedValue({ count: 1 });
    transaction.identifierRelease.create.mockResolvedValue(activeRelease);

    const response = await app.inject({
      cookies: { fluke_admin: adminToken, fluke_csrf: token },
      headers: { 'x-fluke-csrf': token },
      method: 'POST', payload: registration,
      url: '/api/v1/admin/identifier/releases/accept',
    });

    expect(response.statusCode).toBe(201);
    expect(transaction.identifierRelease.updateMany).toHaveBeenCalledWith({
      data: { status: 'ACCEPTED' }, where: { status: 'ACTIVE' },
    });
    expect(transaction.identifierRelease.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        catalogInventory: inventory,
        rightsAttestationDigest: DIGEST,
        sequence: 2n,
        status: 'ACTIVE',
      }),
    }));
    expect(transaction.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'IDENTIFIER_RELEASE_ACCEPTED',
        entityId: 'manifest-v2',
        metadata: expect.objectContaining({ rightsAttestationDigest: DIGEST }),
        userId: ADMIN.userId,
      }),
    }));
  });

  it('rejects non-increasing sequences and conflicting manifest replays', async () => {
    const token = csrfToken();
    transaction.identifierRelease.findUnique.mockResolvedValueOnce(null);
    transaction.identifierRelease.findFirst.mockResolvedValueOnce({ sequence: 2n });
    const nonIncreasing = await app.inject({
      cookies: { fluke_admin: adminToken, fluke_csrf: token },
      headers: { 'x-fluke-csrf': token }, method: 'POST', payload: registration,
      url: '/api/v1/admin/identifier/releases/accept',
    });
    transaction.identifierRelease.findUnique.mockResolvedValueOnce(activeRelease);
    const replay = await app.inject({
      cookies: { fluke_admin: adminToken, fluke_csrf: token },
      headers: { 'x-fluke-csrf': token }, method: 'POST', payload: registration,
      url: '/api/v1/admin/identifier/releases/accept',
    });
    expect(nonIncreasing.statusCode).toBe(409);
    expect(replay.statusCode).toBe(409);
    expect(transaction.identifierRelease.create).not.toHaveBeenCalled();
  });

  it('revokes in place, retains history, and audits the lifecycle change', async () => {
    const token = csrfToken();
    transaction.identifierRelease.findUnique.mockResolvedValue(activeRelease);
    transaction.identifierRelease.update.mockResolvedValue({
      ...activeRelease, revokedAt: new Date('2026-07-19T12:00:00.000Z'), status: 'REVOKED',
    });
    const response = await app.inject({
      cookies: { fluke_admin: adminToken, fluke_csrf: token },
      headers: { 'x-fluke-csrf': token }, method: 'POST',
      url: '/api/v1/admin/identifier/releases/manifest-v2/revoke',
    });
    expect(response.statusCode).toBe(200);
    expect(transaction.identifierRelease.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { revokedAt: expect.any(Date), status: 'REVOKED' },
      where: { manifestVersion: 'manifest-v2' },
    }));
    expect(transaction.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'IDENTIFIER_RELEASE_REVOKED' }),
    }));
    expect(transaction.identifierRelease.create).not.toHaveBeenCalled();
  });

  it('retries a bounded serializable registration after P2034 with no visible winner', async () => {
    const token = csrfToken();
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(prismaRace('P2034'));
    transaction.identifierRelease.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    transaction.identifierRelease.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ sequence: 1n });
    transaction.whale.findMany.mockResolvedValue([{ catalogId: 'J35', id: 'whale-j35' }]);
    transaction.identifierRelease.updateMany.mockResolvedValue({ count: 1 });
    transaction.identifierRelease.create.mockResolvedValue(activeRelease);

    const response = await app.inject({
      cookies: { fluke_admin: adminToken, fluke_csrf: token },
      headers: { 'x-fluke-csrf': token }, method: 'POST', payload: registration,
      remoteAddress: '127.0.0.31', url: '/api/v1/admin/identifier/releases/accept',
    });

    expect(response.statusCode).toBe(201);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: 'Serializable', maxWait: expect.any(Number), timeout: expect.any(Number),
    });
  });

  it.each(['P2002', 'P2034'] as const)(
    'maps a %s registration race with a visible winner to conflict',
    async (code) => {
      const token = csrfToken();
      vi.mocked(prisma.$transaction).mockRejectedValueOnce(prismaRace(code));
      transaction.identifierRelease.findUnique.mockResolvedValueOnce(activeRelease);

      const response = await app.inject({
        cookies: { fluke_admin: adminToken, fluke_csrf: token },
        headers: { 'x-fluke-csrf': token }, method: 'POST', payload: registration,
        remoteAddress: `127.0.0.${code === 'P2002' ? '32' : '33'}`,
        url: '/api/v1/admin/identifier/releases/accept',
      });

      expect(response.statusCode).toBe(409);
      expect(transaction.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it.each(['P2002', 'P2034'] as const)(
    'returns the terminal revoke winner after a %s race without duplicate audit',
    async (code) => {
      const token = csrfToken();
      vi.mocked(prisma.$transaction).mockRejectedValueOnce(prismaRace(code));
      transaction.identifierRelease.findUnique.mockResolvedValueOnce({
        manifestVersion: activeRelease.manifestVersion, status: 'REVOKED',
      });

      const response = await app.inject({
        cookies: { fluke_admin: adminToken, fluke_csrf: token },
        headers: { 'x-fluke-csrf': token }, method: 'POST',
        remoteAddress: `127.0.0.${code === 'P2002' ? '34' : '35'}`,
        url: '/api/v1/admin/identifier/releases/manifest-v2/revoke',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ manifestVersion: 'manifest-v2', status: 'REVOKED' });
      expect(transaction.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it('rate limits repeated release mutations with a safe error', async () => {
    const responses = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      responses.push(await app.inject({
        cookies: { fluke_admin: adminToken }, method: 'POST', payload: registration,
        url: '/api/v1/admin/identifier/releases/accept',
      }));
    }
    const limited = responses.find((response) => response.statusCode === 429);
    expect(limited?.json()).toMatchObject({
      code: 'RATE_LIMITED', retryable: true,
    });
  });
});
