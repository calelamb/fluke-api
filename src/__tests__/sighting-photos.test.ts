import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import FormData from 'form-data';

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
    sightingPhoto: {
      count: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    sightingWhale: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

const { prisma } = await import('../db.js');

let uploadsRoot: string;

vi.mock('../lib/storage.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/storage.js')>('../lib/storage.js');
  return {
    ...actual,
    resolveUploadsDir: () => uploadsRoot,
    getStorageBackend: () =>
      new actual.LocalDiskBackend({
        rootDir: uploadsRoot,
        apiOrigin: 'http://localhost:4000',
      }),
  };
});

const { buildApp } = await import('../app.js');

const ADMIN = {
  userId: 'admin-uuid',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
};

async function buildPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 30, g: 90, b: 140 },
    },
  })
    .png()
    .toBuffer();
}

function recentPendingSighting(overrides: Partial<{ id: string; status: string; createdAt: Date }> = {}) {
  return {
    id: 's1',
    status: 'PENDING',
    createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago, well within window
    ...overrides,
  };
}

describe('POST /api/v1/sightings/:id/photos', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    uploadsRoot = await mkdtemp(path.join(tmpdir(), 'fluke-photos-test-'));
    app = await buildApp({ silent: true });
    await app.ready();
    adminToken = app.jwt.sign(ADMIN, { expiresIn: '7d' });
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadsRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('photo-upload token (offline replay)', () => {
    it('allows public upload past the 30-min window when a valid token is supplied', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue(
        recentPendingSighting({
          createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000), // 6 hours ago
        }) as never,
      );
      vi.mocked(prisma.sightingPhoto.count).mockResolvedValue(0);
      vi.mocked(prisma.sightingPhoto.create).mockResolvedValue({
        id: 'photo-1',
        url: 'placeholder',
        thumbnailUrl: 'placeholder',
        orderIndex: 0,
      } as never);

      const token = app.jwt.sign(
        { sightingId: 's1', type: 'photo-upload' },
        { expiresIn: '24h' },
      );

      const png = await buildPng();
      const form = new FormData();
      form.append('file', png, { filename: 'orca.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings/s1/photos',
        payload: form,
        headers: { ...form.getHeaders(), 'x-photo-upload-token': token },
      });

      expect(response.statusCode).toBe(201);
      // No audit log — token-bypass paths are still public uploads.
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects with 403 when the token is for a different sightingId', async () => {
      const token = app.jwt.sign(
        { sightingId: 'different-sighting', type: 'photo-upload' },
        { expiresIn: '24h' },
      );

      const png = await buildPng();
      const form = new FormData();
      form.append('file', png, { filename: 'a.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings/s1/photos',
        payload: form,
        headers: { ...form.getHeaders(), 'x-photo-upload-token': token },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
      // Should bail before touching the DB.
      expect(prisma.sighting.findUnique).not.toHaveBeenCalled();
      expect(prisma.sightingPhoto.create).not.toHaveBeenCalled();
    });

    it('rejects with 403 when the token has expired', async () => {
      // Mock jwt.verify to throw a TokenExpiredError-like error.
      const originalVerify = app.jwt.verify;
      const verifySpy = vi.spyOn(app.jwt, 'verify').mockImplementation(() => {
        throw new Error('jwt expired');
      });

      const png = await buildPng();
      const form = new FormData();
      form.append('file', png, { filename: 'a.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings/s1/photos',
        payload: form,
        headers: {
          ...form.getHeaders(),
          'x-photo-upload-token': 'any.token.value',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
      expect(prisma.sightingPhoto.create).not.toHaveBeenCalled();

      verifySpy.mockRestore();
      // Restore original (defensive — mockRestore should already do this).
      app.jwt.verify = originalVerify;
    });

    it('rejects with 403 when the token has the wrong type claim', async () => {
      const token = app.jwt.sign(
        { sightingId: 's1', type: 'admin-session' },
        { expiresIn: '24h' },
      );

      const png = await buildPng();
      const form = new FormData();
      form.append('file', png, { filename: 'a.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings/s1/photos',
        payload: form,
        headers: { ...form.getHeaders(), 'x-photo-upload-token': token },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
      expect(prisma.sightingPhoto.create).not.toHaveBeenCalled();
    });
  });

  describe('public unauthenticated upload', () => {
    it('accepts a photo on a recent PENDING sighting (within 30-min window)', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue(recentPendingSighting() as never);
      vi.mocked(prisma.sightingPhoto.count).mockResolvedValue(0);
      vi.mocked(prisma.sightingPhoto.create).mockResolvedValue({
        id: 'photo-1',
        url: 'placeholder',
        thumbnailUrl: 'placeholder',
        orderIndex: 0,
      } as never);

      const png = await buildPng();
      const form = new FormData();
      form.append('file', png, { filename: 'orca.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings/s1/photos',
        payload: form,
        headers: form.getHeaders(),
      });

      expect(response.statusCode).toBe(201);
      // No audit log for public uploads.
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects with 403 when the sighting is APPROVED', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue(
        recentPendingSighting({ status: 'APPROVED' }) as never,
      );

      const png = await buildPng();
      const form = new FormData();
      form.append('file', png, { filename: 'a.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings/s1/photos',
        payload: form,
        headers: form.getHeaders(),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
      expect(prisma.sightingPhoto.create).not.toHaveBeenCalled();
    });

    it('rejects with 403 when the sighting is older than the 30-min window', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue(
        recentPendingSighting({
          createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
        }) as never,
      );

      const png = await buildPng();
      const form = new FormData();
      form.append('file', png, { filename: 'a.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings/s1/photos',
        payload: form,
        headers: form.getHeaders(),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
    });
  });

  describe('admin upload', () => {
    it('accepts a photo with no time window or status restriction', async () => {
      vi.mocked(prisma.sighting.findUnique).mockResolvedValue({
        id: 's1',
        status: 'APPROVED',
        // 90 days ago — way past the public window, but admins can still upload
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      } as never);
      vi.mocked(prisma.sightingPhoto.count).mockResolvedValue(0);
      vi.mocked(prisma.sightingPhoto.create).mockResolvedValue({
        id: 'photo-1',
        url: 'placeholder',
        thumbnailUrl: 'placeholder',
        orderIndex: 0,
      } as never);

      const png = await buildPng();
      const form = new FormData();
      form.append('file', png, { filename: 'orca.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sightings/s1/photos',
        payload: form,
        headers: { ...form.getHeaders(), cookie: `fluke_admin=${adminToken}` },
      });

      expect(response.statusCode).toBe(201);
      // Admin uploads write an audit log.
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'UPLOAD_SIGHTING_PHOTO',
          }),
        }),
      );
    });
  });

  it('returns 404 when the sighting is missing', async () => {
    vi.mocked(prisma.sighting.findUnique).mockResolvedValue(null);

    const png = await buildPng();
    const form = new FormData();
    form.append('file', png, { filename: 'a.png', contentType: 'image/png' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sightings/missing/photos',
      payload: form,
      headers: form.getHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects unsupported content types with 415', async () => {
    vi.mocked(prisma.sighting.findUnique).mockResolvedValue(recentPendingSighting() as never);
    vi.mocked(prisma.sightingPhoto.count).mockResolvedValue(0);

    const form = new FormData();
    form.append('file', Buffer.from('not an image'), {
      filename: 'a.svg',
      contentType: 'image/svg+xml',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sightings/s1/photos',
      payload: form,
      headers: form.getHeaders(),
    });

    expect(response.statusCode).toBe(415);
    expect(prisma.sightingPhoto.create).not.toHaveBeenCalled();
  });

  it('rejects when sighting already has 5 photos', async () => {
    vi.mocked(prisma.sighting.findUnique).mockResolvedValue(recentPendingSighting() as never);
    vi.mocked(prisma.sightingPhoto.count).mockResolvedValue(5);

    const png = await buildPng();
    const form = new FormData();
    form.append('file', png, { filename: 'a.png', contentType: 'image/png' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sightings/s1/photos',
      payload: form,
      headers: form.getHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
  });

  it('writes 1024w + 256w variants to disk and persists a SightingPhoto row', async () => {
    vi.mocked(prisma.sighting.findUnique).mockResolvedValue(recentPendingSighting() as never);
    vi.mocked(prisma.sightingPhoto.count).mockResolvedValue(0);
    vi.mocked(prisma.sightingPhoto.create).mockResolvedValue({
      id: 'photo-1',
      url: 'placeholder',
      thumbnailUrl: 'placeholder',
      orderIndex: 0,
    } as never);

    const png = await buildPng();
    const form = new FormData();
    form.append('file', png, { filename: 'orca.png', contentType: 'image/png' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sightings/s1/photos',
      payload: form,
      headers: form.getHeaders(),
    });

    expect(response.statusCode).toBe(201);

    expect(prisma.sightingPhoto.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sightingId: 's1',
          orderIndex: 0,
          url: expect.stringMatching(/^http:\/\/localhost:4000\/uploads\/sightings\/s1\/.+-1024\.webp$/),
          thumbnailUrl: expect.stringMatching(
            /^http:\/\/localhost:4000\/uploads\/sightings\/s1\/.+-256\.webp$/,
          ),
        }),
      }),
    );

    const written = await readdir(path.join(uploadsRoot, 'sightings/s1'));
    expect(written.some((f) => f.endsWith('-1024.webp'))).toBe(true);
    expect(written.some((f) => f.endsWith('-256.webp'))).toBe(true);
  });
});
