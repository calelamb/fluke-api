import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

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
    it('returns all whales mapped through the DTO shape', async () => {
      vi.mocked(prisma.whale.findMany).mockResolvedValue([baseWhale]);

      const response = await app.inject({ method: 'GET', url: '/api/v1/whales' });

      expect(response.statusCode).toBe(200);
      const body = response.json<Array<{ catalogId: string; notableEvents: unknown[] }>>();
      expect(body).toHaveLength(1);
      expect(body[0].catalogId).toBe('J35');
      expect(body[0].notableEvents).toHaveLength(2);
    });

    it('caps at 50 results', async () => {
      vi.mocked(prisma.whale.findMany).mockResolvedValue([]);

      await app.inject({ method: 'GET', url: '/api/v1/whales' });

      expect(prisma.whale.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });
  });

  describe('GET /api/v1/whales/:catalogId', () => {
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
        url: '/api/v1/whales/J35',
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

      await app.inject({ method: 'GET', url: '/api/v1/whales/J35' });

      expect(prisma.whale.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            sightings: expect.objectContaining({ take: 25 }),
          }),
        }),
      );
    });
  });
});
