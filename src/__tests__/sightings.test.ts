import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SafeErrorSchema, SightingPageSchema, SubmitSightingPayloadSchema } from '../contracts/index.js';

vi.mock('../db.js', () => {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ set_config: '5000ms' }]),
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
    submissionIdempotency: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };
  return {
    prisma: {
      ...transaction,
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction)),
    },
  };
});

const resolveOptionalObserver = vi.fn();
const requireCsrf = vi.fn();
vi.mock('../lib/observer-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/observer-auth.js')>('../lib/observer-auth.js');
  return { ...actual, resolveOptionalObserver };
});
vi.mock('../lib/csrf.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/csrf.js')>('../lib/csrf.js');
  return { ...actual, requireCsrf };
});

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
    resolveOptionalObserver.mockResolvedValue(null);
  });

  describe('GET /api/v1/sightings', () => {
    it('returns approved sightings only in the public page contract', async () => {
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
      const body = SightingPageSchema.parse(response.json());
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe('s1');
      expect(body.items[0].status).toBe('APPROVED');
      // Photos must be sorted by orderIndex ascending.
      expect(body.items[0].photoUrls).toEqual([
        'https://cdn/photo-0.jpg',
        'https://cdn/photo-1.jpg',
      ]);
      expect(body.items[0].photos.map((photo) => photo.url)).toEqual([
        'https://cdn/photo-0.jpg',
        'https://cdn/photo-1.jpg',
      ]);
      expect(body.items[0].identifiedWhales[0].catalogId).toBe('J35');

      // The query restricts to APPROVED.
      expect(prisma.sighting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
          take: 51,
          where: { status: 'APPROVED' },
        }),
      );
    });

    it('uses the ID tie breaker when equal timestamps cross a page boundary', async () => {
      const observedAt = new Date('2026-04-25T12:00:00.000Z');
      const makeRow = (id: string) => ({
        id,
        observedAt,
        latitude: 48.5,
        longitude: -123,
        locationName: null,
        ecotypeGuess: null,
        groupSize: null,
        behaviorNotes: null,
        status: 'APPROVED',
        photos: [],
        whales: [],
      });
      vi.mocked(prisma.sighting.findMany)
        .mockResolvedValueOnce([makeRow('same-time-b'), makeRow('same-time-a')] as never)
        .mockResolvedValueOnce([makeRow('same-time-a')] as never);

      const first = await app.inject({ method: 'GET', url: '/api/v1/sightings?limit=1' });
      const firstPage = SightingPageSchema.parse(first.json());
      expect(firstPage.items.map((item) => item.id)).toEqual(['same-time-b']);
      if (!firstPage.page.hasMore) throw new Error('expected next page');

      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/sightings?limit=1&cursor=${encodeURIComponent(firstPage.page.nextCursor)}`,
      });
      expect(SightingPageSchema.parse(second.json()).items.map((item) => item.id))
        .toEqual(['same-time-a']);
      expect(prisma.sighting.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: {
          AND: [
            { status: 'APPROVED' },
            {
              OR: [
                { observedAt: { lt: observedAt } },
                { observedAt, id: { lt: 'same-time-b' } },
              ],
            },
          ],
        },
      }));
    });

    it('rejects malformed cursors with the safe 400 envelope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sightings?cursor=malformed',
      });

      expect(response.statusCode).toBe(400);
      expect(SafeErrorSchema.parse(response.json()).code).toBe('VALIDATION_ERROR');
      expect(prisma.sighting.findMany).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/sightings', () => {
    const validBody = {
      clientSubmissionId: 'e0f59404-ded3-4a07-8b3e-247ec89adcf7',
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

    it('creates a new sighting with PENDING status and returns a photo-upload token', async () => {
      vi.mocked(prisma.sighting.create).mockResolvedValue({ id: 'new-sighting-id' } as never);
      vi.mocked(prisma.submissionIdempotency.findUnique).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings',
        payload: validBody,
      });

      expect(response.statusCode).toBe(201);
      const body = response.json<{ ok: true; id: string; photoUploadToken: string }>();
      expect(body.ok).toBe(true);
      expect(body.id).toBe('new-sighting-id');
      expect(body.photoUploadToken).toBeTypeOf('string');
      expect(body.photoUploadToken.length).toBeGreaterThan(0);
      // Verify the token round-trips and carries the expected claims.
      const decoded = app.jwt.verify<{ sightingId: string; type: string }>(body.photoUploadToken);
      expect(decoded.sightingId).toBe('new-sighting-id');
      expect(decoded.type).toBe('photo-upload');

      expect(prisma.sighting.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING',
            observerEmail: 'observer@example.com',
          }),
        }),
      );
      expect(prisma.submissionIdempotency.create).toHaveBeenCalledTimes(1);
    });

    it('replays the original response without creating another sighting', async () => {
      vi.mocked(prisma.submissionIdempotency.findUnique)
        .mockResolvedValue({
          requestHash: 'placeholder',
          sighting: { id: 'original-sighting' },
        } as never);

      const { buildSubmissionHashes } = await import('../lib/idempotency.js');
      const hashes = buildSubmissionHashes(SubmitSightingPayloadSchema.parse(validBody), null);
      vi.mocked(prisma.submissionIdempotency.findUnique).mockResolvedValue({
        requestHash: hashes.requestHash,
        sighting: { id: 'original-sighting' },
      } as never);

      const response = await app.inject({
        headers: { 'idempotency-key': validBody.clientSubmissionId },
        method: 'POST', payload: validBody, url: '/api/v1/sightings',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe('original-sighting');
      expect(prisma.sighting.create).not.toHaveBeenCalled();
    });

    it('returns 409 for a changed payload with the same idempotency key', async () => {
      vi.mocked(prisma.submissionIdempotency.findUnique).mockResolvedValue({
        requestHash: 'different-request-hash',
        sighting: { id: 'original-sighting' },
      } as never);

      const response = await app.inject({
        headers: { 'idempotency-key': validBody.clientSubmissionId },
        method: 'POST', payload: { ...validBody, latitude: 49 }, url: '/api/v1/sightings',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('CONFLICT');
      expect(prisma.sighting.create).not.toHaveBeenCalled();
    });

    it('requires CSRF for an authenticated observer and records ownership', async () => {
      resolveOptionalObserver.mockResolvedValue({
        displayName: 'Account Name', email: 'account@example.com', id: 'observer-1',
        role: 'OBSERVER', sessionVersion: 1,
      });
      vi.mocked(prisma.submissionIdempotency.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.sighting.create).mockResolvedValue({ id: 'owned-sighting' } as never);

      const response = await app.inject({
        method: 'POST', payload: validBody, url: '/api/v1/sightings',
      });

      expect(response.statusCode).toBe(201);
      expect(requireCsrf).toHaveBeenCalledTimes(1);
      expect(prisma.sighting.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          observerEmail: 'account@example.com', observerName: 'Account Name',
          observerUserId: 'observer-1',
        }),
      }));
    });

    it('rejects payloads with an invalid email', async () => {
      const response = await app.inject({
        method: 'POST',
        remoteAddress: '127.0.0.2',
        url: '/api/v1/sightings',
        payload: { ...validBody, observerEmail: 'not-an-email' },
      });

      expect(response.statusCode).toBe(400);
      expect(prisma.sighting.create).not.toHaveBeenCalled();
    });

    it('rejects out-of-range coordinates', async () => {
      const response = await app.inject({
        method: 'POST',
        remoteAddress: '127.0.0.3',
        url: '/api/v1/sightings',
        payload: { ...validBody, latitude: 200 },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
