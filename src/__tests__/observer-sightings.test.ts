import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MySightingPageSchema } from '../contracts/index.js';

vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    whale: { findMany: vi.fn(), findUnique: vi.fn() },
    sighting: { findMany: vi.fn(), findUnique: vi.fn() },
    sightingPhoto: { findUnique: vi.fn() },
  },
}));

const requireObserver = vi.fn();
vi.mock('../lib/observer-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/observer-auth.js')>('../lib/observer-auth.js');
  return { ...actual, requireObserver };
});

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

describe('GET /api/v1/sightings/me', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ silent: true });
    await app.ready();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    vi.clearAllMocks();
    requireObserver.mockImplementation(async (request: { observer?: unknown }) => {
      request.observer = {
        displayName: 'Observer One', email: 'one@example.com', id: 'observer-one',
        role: 'OBSERVER', sessionVersion: 1,
      };
    });
  });

  it('returns only the authenticated observer records in a privacy-safe DTO', async () => {
    vi.mocked(prisma.sighting.findMany).mockResolvedValue([{
      behaviorNotes: null,
      createdAt: new Date('2026-07-17T12:01:00.000Z'),
      ecotypeGuess: null,
      groupSize: null,
      id: 'observer-one-sighting',
      latitude: 48.5,
      locationName: null,
      longitude: -123,
      observedAt: new Date('2026-07-17T12:00:00.000Z'),
      rejectionReason: null,
      status: 'PENDING',
      _count: { photos: 2 },
    }] as never);

    const response = await app.inject({ method: 'GET', url: '/api/v1/sightings/me' });

    expect(response.statusCode).toBe(200);
    const body = MySightingPageSchema.parse(response.json());
    expect(body.items.map(({ id }) => id)).toEqual(['observer-one-sighting']);
    expect(body.items[0]).not.toHaveProperty('observerEmail');
    expect(prisma.sighting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: 51,
      where: { observerUserId: 'observer-one' },
    }));
  });
});
