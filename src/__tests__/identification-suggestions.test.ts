import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const transaction = {
  auditLog: { create: vi.fn() },
  sightingIdentificationSuggestion: {
    findUnique: vi.fn(), updateMany: vi.fn(),
  },
  sightingWhale: { createMany: vi.fn() },
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
const CSRF_SECRET = 'suggestion-moderation-test-secret-that-is-longer-than-forty-three-characters';
const MODERATOR = Object.freeze({
  email: 'moderator@example.invalid', role: 'MODERATOR' as const, userId: 'moderator-id',
});
const OBSERVER = Object.freeze({
  email: 'observer@example.invalid', role: 'OBSERVER', userId: 'observer-id',
});
const pending = Object.freeze({
  id: 'suggestion-1', reviewedAt: null, reviewedById: null,
  sightingId: 'sighting-1', status: 'PENDING' as const, whaleId: 'whale-1',
});

function csrfToken(): string {
  const raw = 's'.repeat(43);
  return `${raw}.${createHmac('sha256', CSRF_SECRET).update(raw).digest('base64url')}`;
}

describe('identification suggestion moderation', () => {
  let app: FastifyInstance;
  let moderatorToken: string;
  let observerToken: string;

  beforeAll(async () => {
    process.env.OBSERVER_CSRF_SECRET = CSRF_SECRET;
    app = await buildApp({ silent: true });
    await app.ready();
    moderatorToken = app.jwt.sign(MODERATOR);
    observerToken = app.jwt.sign(OBSERVER);
  });
  afterAll(async () => app.close());
  beforeEach(() => vi.clearAllMocks());

  it('preserves anonymous, wrong-role, and CSRF failures', async () => {
    const anonymous = await app.inject({
      method: 'POST', url: '/api/v1/admin/identification-suggestions/suggestion-1/accept',
    });
    const wrongRole = await app.inject({
      cookies: { fluke_admin: observerToken }, method: 'POST',
      url: '/api/v1/admin/identification-suggestions/suggestion-1/accept',
    });
    const noCsrf = await app.inject({
      cookies: { fluke_admin: moderatorToken }, method: 'POST',
      url: '/api/v1/admin/identification-suggestions/suggestion-1/accept',
    });
    expect(anonymous.statusCode).toBe(401);
    expect(wrongRole.statusCode).toBe(401);
    expect(noCsrf.statusCode).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a suggestion without approving its sighting', async () => {
    const token = csrfToken();
    transaction.sightingIdentificationSuggestion.findUnique.mockResolvedValue(pending);
    transaction.sightingIdentificationSuggestion.updateMany.mockResolvedValue({ count: 1 });
    transaction.sightingWhale.createMany.mockResolvedValue({ count: 1 });
    const response = await app.inject({
      cookies: { fluke_admin: moderatorToken, fluke_csrf: token },
      headers: { 'x-fluke-csrf': token }, method: 'POST',
      url: '/api/v1/admin/identification-suggestions/suggestion-1/accept',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'suggestion-1', status: 'ACCEPTED' });
    expect(transaction.sightingIdentificationSuggestion.updateMany).toHaveBeenCalledWith({
      data: {
        reviewedAt: expect.any(Date), reviewedById: MODERATOR.userId, status: 'ACCEPTED',
      },
      where: { id: 'suggestion-1', status: 'PENDING' },
    });
    expect(transaction.sightingWhale.createMany).toHaveBeenCalledWith({
      data: [{ confidence: 'ML_SUGGESTED', sightingId: 'sighting-1', whaleId: 'whale-1' }],
      skipDuplicates: true,
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'IDENTIFICATION_SUGGESTION_ACCEPTED' }),
    }));
    expect((transaction as Record<string, unknown>).sighting).toBeUndefined();
  });

  it('rejects without linking a whale and audits in the same transaction', async () => {
    const token = csrfToken();
    transaction.sightingIdentificationSuggestion.findUnique.mockResolvedValue(pending);
    transaction.sightingIdentificationSuggestion.updateMany.mockResolvedValue({ count: 1 });
    const response = await app.inject({
      cookies: { fluke_admin: moderatorToken, fluke_csrf: token },
      headers: { 'x-fluke-csrf': token }, method: 'POST',
      url: '/api/v1/admin/identification-suggestions/suggestion-1/reject',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'suggestion-1', status: 'REJECTED' });
    expect(transaction.sightingWhale.createMany).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'IDENTIFICATION_SUGGESTION_REJECTED' }),
    }));
  });

  it('replays the same terminal action without duplicate link or audit', async () => {
    const token = csrfToken();
    transaction.sightingIdentificationSuggestion.findUnique.mockResolvedValue({
      ...pending, reviewedAt: new Date('2026-07-19T12:00:00.000Z'),
      reviewedById: MODERATOR.userId, status: 'ACCEPTED',
    });
    const response = await app.inject({
      cookies: { fluke_admin: moderatorToken, fluke_csrf: token },
      headers: { 'x-fluke-csrf': token }, method: 'POST',
      url: '/api/v1/admin/identification-suggestions/suggestion-1/accept',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'suggestion-1', status: 'ACCEPTED' });
    expect(transaction.sightingIdentificationSuggestion.updateMany).not.toHaveBeenCalled();
    expect(transaction.sightingWhale.createMany).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects an opposite terminal decision as a conflict', async () => {
    const token = csrfToken();
    transaction.sightingIdentificationSuggestion.findUnique.mockResolvedValue({
      ...pending, status: 'REJECTED',
    });
    const response = await app.inject({
      cookies: { fluke_admin: moderatorToken, fluke_csrf: token },
      headers: { 'x-fluke-csrf': token }, method: 'POST',
      url: '/api/v1/admin/identification-suggestions/suggestion-1/accept',
    });
    expect(response.statusCode).toBe(409);
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('rate limits repeated moderation mutations with a safe error', async () => {
    const responses = [];
    for (let attempt = 0; attempt < 61; attempt += 1) {
      responses.push(await app.inject({
        cookies: { fluke_admin: moderatorToken }, method: 'POST',
        url: '/api/v1/admin/identification-suggestions/suggestion-1/accept',
      }));
    }
    const limited = responses.find((response) => response.statusCode === 429);
    expect(limited?.json()).toMatchObject({
      code: 'RATE_LIMITED', retryable: true,
    });
  });
});
