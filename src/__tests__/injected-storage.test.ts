import FormData from 'form-data';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../db.js', () => {
  const database = {
    $executeRaw: vi.fn(),
    auditLog: { create: vi.fn() },
    sighting: { findUnique: vi.fn() },
    sightingPhoto: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    sightingWhale: { upsert: vi.fn() },
    user: { findUnique: vi.fn() },
    whale: { findMany: vi.fn(), findUnique: vi.fn() },
  };
  return {
    prisma: {
      ...database,
      $transaction: vi.fn(async (callback: (client: typeof database) => unknown) => {
        await callback(database);
        throw new Error('commit failed');
      }),
    },
  };
});

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

describe('observer storage dependency integration', () => {
  let app: FastifyInstance;
  const put = vi.fn(async ({ body, filename, prefix }) => ({
    key: `${prefix}/${filename}`,
    size: Buffer.isBuffer(body) ? body.byteLength : 1,
  }));
  const remove = vi.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    app = await buildApp({
      features: {
        accounts: true,
        identification: false,
        identificationMode: 'disabled',
        submissions: true,
      },
      observerAuth: {
        appleAuth: {
          exchangeAppleAuthorizationCode: vi.fn(),
          revokeAppleRefreshToken: vi.fn(),
          verifyAppleIdentityToken: vi.fn(),
        },
        storage: { publicUrl: vi.fn(), put, remove },
        tokenCrypto: { decryptToken: vi.fn(), encryptToken: vi.fn() },
      },
      silent: true,
    });
    await app.ready();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.sighting.findUnique).mockResolvedValue({
      createdAt: new Date(),
      id: 'injected-sighting',
      observerUserId: null,
      status: 'PENDING',
    } as never);
    vi.mocked(prisma.sightingPhoto.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.sightingPhoto.count).mockResolvedValue(0);
    vi.mocked(prisma.sightingPhoto.create).mockResolvedValue({
      id: 'injected-photo',
      orderIndex: 0,
      sightingId: 'injected-sighting',
      storageKey: 'placeholder',
      thumbnailUrl: 'thumbnail',
      url: 'large',
    } as never);
  });

  it('uses injected storage for both photo puts and commit-failure compensation', async () => {
    const clientSubmissionId = 'e0f59404-ded3-4a07-8b3e-247ec89adcf7';
    const token = app.jwt.sign({
      clientSubmissionId,
      sightingId: 'injected-sighting',
      type: 'photo-upload',
    }, { expiresIn: '1h' });
    const photo = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#123456' },
    }).png().toBuffer();
    const form = new FormData();
    form.append('file', photo, { contentType: 'image/png', filename: 'injected.png' });

    const response = await app.inject({
      headers: {
        ...form.getHeaders(),
        'idempotency-key': `${clientSubmissionId}:3c2cb2b4-f5a8-4cd0-bd29-d1cd22632887`,
        'x-photo-upload-token': token,
      },
      method: 'POST',
      payload: form,
      url: '/api/v1/sightings/injected-sighting/photos',
    });

    expect(response.statusCode).toBe(500);
    expect(put).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
    const writtenKeys = put.mock.calls.map(([input]) => `${input.prefix}/${input.filename}`);
    expect(remove.mock.calls.map(([key]) => key)).toEqual(writtenKeys);
  });
});
