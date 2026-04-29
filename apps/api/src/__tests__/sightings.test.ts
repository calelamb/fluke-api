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
    sightingWhale: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

describe('sightings routes', () => {
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

  describe('GET /api/v1/sightings', () => {
    it('returns approved sightings only and reshapes to the public DTO', async () => {
      vi.mocked(prisma.sighting.findMany).mockResolvedValue([
        {
          id: 's1',
          observedAt: new Date('2026-04-25T12:00:00Z'),
          latitude: 48.5,
          longitude: -123.0,
          locationName: 'Haro Strait',
          ecotypeGuess: 'RESIDENT',
          groupSize: 5,
          behaviorNotes: null,
          status: 'APPROVED',
          photos: [
            { id: 'p1', url: 'https://cdn/photo-1.jpg', thumbnailUrl: 'https://cdn/photo-1-thumb.jpg', orderIndex: 1 },
            { id: 'p0', url: 'https://cdn/photo-0.jpg', thumbnailUrl: 'https://cdn/photo-0-thumb.jpg', orderIndex: 0 },
          ],
          whales: [
            {
              confidence: 'CONFIRMED',
              whale: { catalogId: 'J35', name: 'Tahlequah' },
            },
          ],
        },
      ] as never);

      const response = await app.inject({ method: 'GET', url: '/api/v1/sightings' });

      expect(response.statusCode).toBe(200);
      const body = response.json<
        Array<{
          id: string;
          status: string;
          photoUrls: string[];
          photos: Array<{ id: string; url: string; thumbnailUrl: string; orderIndex: number }>;
          identifiedWhales: Array<{ catalogId: string }>;
        }>
      >();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('s1');
      expect(body[0].status).toBe('APPROVED');
      // Photos must be sorted by orderIndex ascending.
      expect(body[0].photoUrls).toEqual([
        'https://cdn/photo-0.jpg',
        'https://cdn/photo-1.jpg',
      ]);
      expect(body[0].photos.map((p) => p.url)).toEqual([
        'https://cdn/photo-0.jpg',
        'https://cdn/photo-1.jpg',
      ]);
      expect(body[0].identifiedWhales[0].catalogId).toBe('J35');

      // The query restricts to APPROVED.
      expect(prisma.sighting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'APPROVED' } }),
      );
    });
  });

  describe('POST /api/v1/sightings', () => {
    const validBody = {
      observedAt: new Date('2026-04-25T18:00:00Z').toISOString(),
      latitude: 48.5,
      longitude: -123.0,
      locationName: 'Haro Strait',
      ecotypeGuess: 'RESIDENT',
      groupSize: 4,
      behaviorNotes: 'Northbound foraging.',
      observerName: 'Test Observer',
      observerEmail: 'observer@example.com',
    };

    it('creates a new sighting with PENDING status', async () => {
      vi.mocked(prisma.sighting.create).mockResolvedValue({ id: 'new-sighting-id' } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings',
        payload: validBody,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ ok: true, id: 'new-sighting-id' });

      expect(prisma.sighting.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING',
            observerEmail: 'observer@example.com',
          }),
        }),
      );
    });

    it('rejects payloads with an invalid email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings',
        payload: { ...validBody, observerEmail: 'not-an-email' },
      });

      expect(response.statusCode).toBe(400);
      expect(prisma.sighting.create).not.toHaveBeenCalled();
    });

    it('rejects out-of-range coordinates', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings',
        payload: { ...validBody, latitude: 200 },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
