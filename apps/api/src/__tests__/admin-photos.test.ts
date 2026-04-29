import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    whale: { findUnique: vi.fn() },
    sightingPhoto: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    photoAnnotation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
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

describe('admin photo labeling routes', () => {
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

  describe('GET /api/v1/admin/photos/pending', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/admin/photos/pending' });
      expect(response.statusCode).toBe(401);
      expect(prisma.sightingPhoto.findMany).not.toHaveBeenCalled();
    });

    it('returns only un-done photos with their latest annotation', async () => {
      vi.mocked(prisma.sightingPhoto.findMany).mockResolvedValue([
        {
          id: 'photo-1',
          url: 'https://example.com/p1.webp',
          thumbnailUrl: 'https://example.com/p1-thumb.webp',
          orderIndex: 0,
          done: false,
          createdAt: new Date('2026-04-26T12:00:00Z'),
          sighting: {
            id: 'sighting-1',
            observedAt: new Date('2026-04-25T12:00:00Z'),
            locationName: 'Haro Strait',
            observerEmail: 'obs@example.com',
          },
          annotations: [],
        },
      ] as never);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/photos/pending',
        cookies: { fluke_admin: adminToken },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<Array<{ id: string; done: boolean; latestAnnotation: unknown }>>();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('photo-1');
      expect(body[0].done).toBe(false);
      expect(body[0].latestAnnotation).toBeNull();
      expect(prisma.sightingPhoto.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { done: false } }),
      );
    });
  });

  describe('POST /api/v1/admin/photos/:photoId/annotate', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/photos/photo-1/annotate',
        payload: { quality: 'USABLE' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('creates a v1 annotation when none exist, then a v2 the next call', async () => {
      vi.mocked(prisma.sightingPhoto.findUnique).mockResolvedValue({
        id: 'photo-1',
        done: false,
      } as never);
      vi.mocked(prisma.whale.findUnique).mockResolvedValue({
        id: 'whale-1',
        catalogId: 'J35',
        name: 'Tahlequah',
      } as never);

      // First call: no prior annotations → version 1.
      vi.mocked(prisma.photoAnnotation.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.photoAnnotation.create).mockResolvedValueOnce({
        id: 'ann-1',
        photoId: 'photo-1',
        version: 1,
        quality: 'USABLE',
        payload: {},
        whale: { catalogId: 'J35', name: 'Tahlequah' },
        confidence: 'LIKELY',
        notes: null,
        done: false,
        labeledById: ADMIN.userId,
        labeledAt: new Date('2026-04-29T10:00:00Z'),
      } as never);

      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/photos/photo-1/annotate',
        cookies: { fluke_admin: adminToken },
        payload: { quality: 'USABLE', whaleCatalogId: 'J35', confidence: 'LIKELY' },
      });

      expect(first.statusCode).toBe(201);
      expect(prisma.photoAnnotation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            photoId: 'photo-1',
            version: 1,
            quality: 'USABLE',
            whaleId: 'whale-1',
          }),
        }),
      );

      // Second call: prior version 1 → version 2.
      vi.mocked(prisma.photoAnnotation.findFirst).mockResolvedValueOnce({ version: 1 } as never);
      vi.mocked(prisma.photoAnnotation.create).mockResolvedValueOnce({
        id: 'ann-2',
        photoId: 'photo-1',
        version: 2,
        quality: 'USABLE',
        payload: { dorsal_fin: { x: 1, y: 2, w: 30, h: 40 } },
        whale: { catalogId: 'J35', name: 'Tahlequah' },
        confidence: 'CONFIRMED',
        notes: 'crisp fin',
        done: true,
        labeledById: ADMIN.userId,
        labeledAt: new Date('2026-04-29T10:05:00Z'),
      } as never);

      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/photos/photo-1/annotate',
        cookies: { fluke_admin: adminToken },
        payload: {
          quality: 'USABLE',
          whaleCatalogId: 'J35',
          confidence: 'CONFIRMED',
          payload: { dorsal_fin: { x: 1, y: 2, w: 30, h: 40 } },
          notes: 'crisp fin',
          done: true,
        },
      });

      expect(second.statusCode).toBe(201);
      const lastCreate = vi.mocked(prisma.photoAnnotation.create).mock.calls.at(-1)![0];
      expect(lastCreate.data.version).toBe(2);
      expect(lastCreate.data.done).toBe(true);
      expect(prisma.sightingPhoto.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'photo-1' },
          data: { done: true },
        }),
      );
    });

    it('writes a LABEL_PHOTO audit log entry', async () => {
      vi.mocked(prisma.sightingPhoto.findUnique).mockResolvedValue({
        id: 'photo-1',
        done: false,
      } as never);
      vi.mocked(prisma.photoAnnotation.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.photoAnnotation.create).mockResolvedValue({
        id: 'ann-1',
        photoId: 'photo-1',
        version: 1,
        quality: 'NOT_ORCA',
        payload: {},
        whale: null,
        confidence: null,
        notes: null,
        done: false,
        labeledById: ADMIN.userId,
        labeledAt: new Date('2026-04-29T10:00:00Z'),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/photos/photo-1/annotate',
        cookies: { fluke_admin: adminToken },
        payload: { quality: 'NOT_ORCA' },
      });

      expect(response.statusCode).toBe(201);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: ADMIN.userId,
            action: 'LABEL_PHOTO',
            entityType: 'sighting_photo',
            entityId: 'photo-1',
            metadata: expect.objectContaining({
              version: 1,
              quality: 'NOT_ORCA',
            }),
          }),
        }),
      );
    });

    it('returns 404 when the photo does not exist', async () => {
      vi.mocked(prisma.sightingPhoto.findUnique).mockResolvedValue(null);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/photos/nope/annotate',
        cookies: { fluke_admin: adminToken },
        payload: { quality: 'USABLE' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/admin/photos/:photoId/annotations', () => {
    it('returns versions newest-first', async () => {
      vi.mocked(prisma.sightingPhoto.findUnique).mockResolvedValue({ id: 'photo-1' } as never);
      vi.mocked(prisma.photoAnnotation.findMany).mockResolvedValue([
        {
          id: 'ann-2',
          photoId: 'photo-1',
          version: 2,
          quality: 'USABLE',
          payload: {},
          whale: null,
          confidence: 'LIKELY',
          notes: null,
          done: false,
          labeledById: ADMIN.userId,
          labeledAt: new Date('2026-04-29T10:05:00Z'),
        },
        {
          id: 'ann-1',
          photoId: 'photo-1',
          version: 1,
          quality: 'OCCLUDED',
          payload: {},
          whale: null,
          confidence: null,
          notes: null,
          done: false,
          labeledById: ADMIN.userId,
          labeledAt: new Date('2026-04-29T10:00:00Z'),
        },
      ] as never);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/photos/photo-1/annotations',
        cookies: { fluke_admin: adminToken },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<Array<{ version: number }>>();
      expect(body.map((a) => a.version)).toEqual([2, 1]);
    });
  });
});
