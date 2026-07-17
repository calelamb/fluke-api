import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SafeErrorSchema, WhalePageSchema, WhaleTrackSchema } from '../contracts/index.js';

vi.mock('../db.js', () => ({
  prisma: {
    whale: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    sighting: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    sightingWhale: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

const baseWhale = {
  id: 'uuid-j35',
  catalogId: 'J35',
  name: 'Tahlequah',
  ecotype: 'RESIDENT' as const,
  pod: 'J',
  sex: 'FEMALE' as const,
  birthYear: 1998,
  deathYear: null,
  status: 'ALIVE' as const,
  biography: 'A J pod orca.',
  distinguishingMarks: null,
  heroImageUrl: null,
  notableEvents: [
    { year: 1998, type: 'birth', summary: 'Born to J17.' },
    { year: 2018, type: 'loss', summary: 'Carried a deceased calf.' },
  ],
  sourceCitations: [{ label: 'CWR', url: 'https://www.whaleresearch.com/' }],
  motherId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('whales routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ silent: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/v1/whales', () => {
    it('returns a runtime-validated cursor page', async () => {
      vi.mocked(prisma.whale.findMany).mockResolvedValue([baseWhale]);

      const response = await app.inject({ method: 'GET', url: '/api/v1/whales' });

      expect(response.statusCode).toBe(200);
      const body = WhalePageSchema.parse(response.json());
      expect(body.items).toHaveLength(1);
      expect(body.items[0].catalogId).toBe('J35');
      expect(body.items[0].notableEvents).toHaveLength(2);
      expect(body.page).toEqual({ hasMore: false, nextCursor: null });
    });

    it('uses limit plus one and an opaque stable catalog cursor', async () => {
      const secondWhale = { ...baseWhale, id: 'uuid-j36', catalogId: 'J36' };
      vi.mocked(prisma.whale.findMany)
        .mockResolvedValueOnce([baseWhale, secondWhale])
        .mockResolvedValueOnce([secondWhale]);

      const first = await app.inject({ method: 'GET', url: '/api/v1/whales?limit=1' });
      const firstPage = WhalePageSchema.parse(first.json());
      expect(firstPage.items.map((whale) => whale.id)).toEqual(['uuid-j35']);
      expect(firstPage.page.hasMore).toBe(true);
      if (!firstPage.page.hasMore) throw new Error('expected next page');

      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/whales?limit=1&cursor=${encodeURIComponent(firstPage.page.nextCursor)}`,
      });
      const secondPage = WhalePageSchema.parse(second.json());
      expect(secondPage.items.map((whale) => whale.id)).toEqual(['uuid-j36']);

      expect(prisma.whale.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ catalogId: 'asc' }, { id: 'asc' }],
          take: 2,
        }),
      );
      expect(prisma.whale.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { catalogId: { gt: 'J35' } },
              { catalogId: 'J35', id: { gt: 'uuid-j35' } },
            ],
          },
        }),
      );
    });

    it('returns a safe 400 for malformed cursors and does not query Prisma', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/whales?cursor=not-an-opaque-cursor',
      });

      expect(response.statusCode).toBe(400);
      expect(SafeErrorSchema.parse(response.json()).code).toBe('VALIDATION_ERROR');
      expect(prisma.whale.findMany).not.toHaveBeenCalled();
    });

    it('returns an ETag and honors conditional GET without changing the payload', async () => {
      vi.mocked(prisma.whale.findMany).mockResolvedValue([baseWhale]);
      const first = await app.inject({ method: 'GET', url: '/api/v1/whales' });
      const etag = first.headers.etag;

      expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/u);
      expect(first.headers['cache-control']).toContain('public');

      const conditional = await app.inject({
        headers: { 'if-none-match': etag },
        method: 'GET',
        url: '/api/v1/whales',
      });
      expect(conditional.statusCode).toBe(304);
      expect(conditional.body).toBe('');
    });

    it('fails safely when database output violates the public contract', async () => {
      vi.mocked(prisma.whale.findMany).mockResolvedValue([{
        ...baseWhale,
        heroImageUrl: 'file:///private/catalog.jpg',
      }]);

      const response = await app.inject({ method: 'GET', url: '/api/v1/whales' });

      expect(response.statusCode).toBe(500);
      expect(SafeErrorSchema.parse(response.json()).code).toBe('INTERNAL_ERROR');
      expect(response.body).not.toContain('file:///private/catalog.jpg');
    });
  });

  describe('GET /api/v1/whales/:id', () => {
    it('returns the profile DTO with sorted events and recent sightings', async () => {
      vi.mocked(prisma.whale.findUnique).mockResolvedValue({
        ...baseWhale,
        // Events out of order on purpose to verify the route sorts ascending.
        notableEvents: [
          { year: 2018, type: 'loss', summary: 'Carried calf.' },
          { year: 1998, type: 'birth', summary: 'Born.' },
        ],
        mother: { catalogId: 'J17', name: 'Princess Angeline' },
        offspring: [{ catalogId: 'J47', name: 'Notch' }],
        sightings: [
          {
            sighting: {
              id: 's1',
              observedAt: new Date('2026-04-20T12:00:00Z'),
              locationName: 'Lime Kiln Point',
              latitude: 48.5159,
              longitude: -123.1521,
            },
          },
        ],
      } as never);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/whales/uuid-j35',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        catalogId: string;
        notableEvents: Array<{ year: number }>;
        mother: { catalogId: string } | null;
        offspring: Array<{ catalogId: string }>;
        recentSightings: Array<{ id: string; observedAt: string }>;
      }>();
      expect(body.catalogId).toBe('J35');
      expect(body.notableEvents.map((e) => e.year)).toEqual([1998, 2018]);
      expect(body.mother?.catalogId).toBe('J17');
      expect(body.offspring).toHaveLength(1);
      expect(body.recentSightings[0].id).toBe('s1');
      expect(prisma.whale.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'uuid-j35' } }),
      );
    });

    it('returns 404 when the whale is missing', async () => {
      vi.mocked(prisma.whale.findUnique).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/whales/UNKNOWN',
      });

      expect(response.statusCode).toBe(404);
    });

    it('asks Prisma for up to 25 recent sightings', async () => {
      vi.mocked(prisma.whale.findUnique).mockResolvedValue({
        ...baseWhale,
        mother: null,
        offspring: [],
        sightings: [],
      } as never);

      await app.inject({ method: 'GET', url: '/api/v1/whales/uuid-j35' });

      expect(prisma.whale.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            sightings: expect.objectContaining({ take: 25 }),
          }),
        }),
      );
    });
  });

  describe('GET /api/v1/whales/:id/track', () => {
    it('returns the canonical ordered track using database whale ID semantics', async () => {
      vi.mocked(prisma.whale.findUnique).mockResolvedValue({
        id: 'uuid-j35',
        catalogId: 'J35',
      } as never);
      vi.mocked(prisma.sighting.findMany).mockResolvedValue([
        {
          id: 'sighting-a',
          observedAt: new Date('2026-04-25T12:00:00.000Z'),
          latitude: 48.5,
          longitude: -123,
          locationName: 'Haro Strait',
          behaviorNotes: 'Northbound',
        },
      ] as never);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/whales/uuid-j35/track',
      });

      expect(response.statusCode).toBe(200);
      expect(WhaleTrackSchema.parse(response.json())).toMatchObject({
        whaleId: 'uuid-j35',
        catalogId: 'J35',
        points: [{ id: 'sighting-a' }],
      });
      expect(prisma.whale.findUnique).toHaveBeenCalledWith({
        where: { id: 'uuid-j35' },
        select: { catalogId: true, id: true },
      });
      expect(prisma.sighting.findMany).toHaveBeenCalledWith(expect.objectContaining({
        orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
        take: 1_000,
        where: {
          status: 'APPROVED',
          whales: { some: { whaleId: 'uuid-j35' } },
        },
      }));
    });

    it('returns a safe 404 for a missing database whale ID', async () => {
      vi.mocked(prisma.whale.findUnique).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/whales/missing-whale/track',
      });

      expect(response.statusCode).toBe(404);
      expect(SafeErrorSchema.parse(response.json()).code).toBe('NOT_FOUND');
      expect(prisma.sighting.findMany).not.toHaveBeenCalled();
    });
  });
});
