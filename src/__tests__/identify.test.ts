import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import FormData from 'form-data';
import sharp from 'sharp';

vi.mock('../db.js', () => ({
  prisma: {
    identificationAttempt: { create: vi.fn() },
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

async function buildPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 20, g: 70, b: 110 },
    },
  })
    .png()
    .toBuffer();
}

describe('POST /api/v1/identify', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    uploadsRoot = await mkdtemp(path.join(tmpdir(), 'fluke-identify-test-'));
    app = await buildApp({
      features: {
        accounts: false,
        identification: true,
        identificationMode: 'server',
        submissions: false,
      },
      silent: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadsRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('requires a multipart image file', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/identify',
      payload: {},
    });

    expect(response.statusCode).toBe(406);
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
    expect(prisma.identificationAttempt.create).not.toHaveBeenCalled();
  });

  it('stores the upload, calls the identifier service, and logs the attempt', async () => {
    const serviceResult = {
      matches: [
        {
          catalogId: 'J35',
          name: 'Tahlequah',
          score: 0.82,
          rank: 1,
          matchedReferencePhotoIds: ['ref-1'],
          explanation: 'Closest visual match across 1 reference photo.',
        },
      ],
      confidenceBand: 'high',
      model: 'miewid-msv3',
      indexVersion: 'test-index',
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => serviceResult,
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(prisma.identificationAttempt.create).mockResolvedValue({ id: 'attempt-1' } as never);

    const form = new FormData();
    form.append('file', await buildPng(), { filename: 'orca.png', contentType: 'image/png' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/identify',
      payload: form,
      headers: form.getHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<typeof serviceResult & { uploadUrl: string }>();
    expect(body.matches[0].catalogId).toBe('J35');
    expect(body.uploadUrl).toMatch(/\/uploads\/identify-uploads\//);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4100/identify-json',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(prisma.identificationAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          uploadKey: expect.stringMatching(/^identify-uploads\//),
          resultJson: expect.objectContaining({ model: 'miewid-msv3' }),
        }),
      }),
    );
  });
});
