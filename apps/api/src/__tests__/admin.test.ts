import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    whale: { findMany: vi.fn(), findUnique: vi.fn() },
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

const ADMIN = {
  userId: 'admin-uuid',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
};

describe('admin routes', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp({ silent: true });
    await app.ready();
    adminToken = app.jwt.sign(ADMIN, { expiresIn: '7d' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/v1/admin/sightings', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/admin/sightings' });
      expect(response.statusCode).toBe(401);
      expect(prisma.sighting.findMany).not.toHaveBeenCalled();
    });

    it('returns the queue for the requested status when authenticated', async () => {
      vi.mocked(prisma.sighting.findMany).mockResolvedValue([
        {
          id: 'pending-1',
          observedAt: new Date('2026-04-25T12:00:00Z'),
          latitude: 48.5,
          longitude: -123.0,
          locationName: 'Haro Strait',
          ecotypeGuess: 'RESIDENT',
          groupSize: 4,
          behaviorNotes: null,
          observerName: null,
          observerEmail: 'obs@example.com',
          status: 'PENDING',
          createdAt: new Date('2026-04-26T12:00:00Z'),
          whales: [],
        },
      ] as never);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sightings?status=PENDING',
        cookies: { fluke_admin: adminToken },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<Array<{ id: string; status: string }>>();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('pending-1');
      expect(prisma.sighting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'PENDING' } }),
      );
    });

    it('rejects invalid status filters with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sightings?status=BOGUS',
        cookies: { fluke_admin: adminToken },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/admin/sightings/:id/approve', () => {
    it('flips status to APPROVED and writes an audit log entry', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue({
        id: 'sighting-1',
        status: 'PENDING',
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/sightings/sighting-1/approve',
        cookies: { fluke_admin: adminToken },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });

      expect(prisma.sighting.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sighting-1' },
          data: expect.objectContaining({
            status: 'APPROVED',
            moderatedById: ADMIN.userId,
          }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: ADMIN.userId,
            action: 'APPROVE_SIGHTING',
            entityType: 'sighting',
            entityId: 'sighting-1',
          }),
        }),
      );
    });

    it('returns 404 for a missing sighting', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/sightings/missing/approve',
        cookies: { fluke_admin: adminToken },
      });

      expect(response.statusCode).toBe(404);
      expect(prisma.sighting.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/admin/sightings/:id/reject', () => {
    it('requires a rejection reason', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/sightings/sighting-1/reject',
        cookies: { fluke_admin: adminToken },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('writes the rejection with reason to the audit log', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue({
        id: 'sighting-1',
        status: 'PENDING',
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/sightings/sighting-1/reject',
        cookies: { fluke_admin: adminToken },
        payload: { reason: 'Not in Salish Sea range' },
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.sighting.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sighting-1' },
          data: expect.objectContaining({
            status: 'REJECTED',
            rejectionReason: 'Not in Salish Sea range',
          }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REJECT_SIGHTING',
            metadata: { reason: 'Not in Salish Sea range' },
          }),
        }),
      );
    });
  });

  describe('POST /api/v1/admin/sightings/:id/link-whale', () => {
    it('upserts the SightingWhale link with the given confidence', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue({ id: 'sighting-1' } as never);
      vi.mocked(prisma.whale.findUnique).mockResolvedValue({ id: 'whale-1', catalogId: 'J35' } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/sightings/sighting-1/link-whale',
        cookies: { fluke_admin: adminToken },
        payload: { catalogId: 'J35', confidence: 'CONFIRMED' },
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.sightingWhale.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            sightingId: 'sighting-1',
            whaleId: 'whale-1',
            confidence: 'CONFIRMED',
          }),
          update: { confidence: 'CONFIRMED' },
        }),
      );
    });

    it('returns 404 when whale or sighting is missing', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.whale.findUnique).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/sightings/missing/link-whale',
        cookies: { fluke_admin: adminToken },
        payload: { catalogId: 'NOPE', confidence: 'CONFIRMED' },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
