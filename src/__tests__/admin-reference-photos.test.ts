import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../db.js', () => ({
  prisma: {
    whaleReferencePhoto: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
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

describe('admin reference-photo routes', () => {
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

  it('lists reference photos for authenticated admins', async () => {
    vi.mocked(prisma.whaleReferencePhoto.findMany).mockResolvedValue([
      {
        id: 'ref-1',
        whaleId: 'whale-1',
        url: 'http://localhost:4000/uploads/reference-photos/ref.webp',
        side: 'LEFT',
        quality: 'USABLE',
        cropX: null,
        cropY: null,
        cropWidth: null,
        cropHeight: null,
        embeddingStatus: 'EMBEDDED',
        notes: 'clean left side',
        createdAt: new Date('2026-04-30T09:00:00Z'),
        whale: { catalogId: 'J35', name: 'Tahlequah' },
      },
    ] as never);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/reference-photos',
      cookies: { fluke_admin: adminToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Array<{ catalogId: string; embeddingStatus: string }>>()).toEqual([
      expect.objectContaining({ catalogId: 'J35', embeddingStatus: 'EMBEDDED' }),
    ]);
  });

  it('does not rebuild an empty identifier index', async () => {
    vi.mocked(prisma.whaleReferencePhoto.findMany).mockResolvedValue([]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/identifier/rebuild-index',
      cookies: { fluke_admin: adminToken },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
  });
});
