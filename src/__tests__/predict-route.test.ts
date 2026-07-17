import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { PredictionSchema, SafeErrorSchema } from '../contracts/index.js';

vi.mock('../db.js', () => {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ set_config: '5000ms' }]),
    predictionGrid: {
      findUnique: vi.fn(),
    },
  };
  return {
    prisma: {
      ...transaction,
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction)),
    },
  };
});

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

describe('GET /api/v1/predict', () => {
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

  it('returns 400 when neither whaleId nor pod is provided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/predict?horizon=24h',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on invalid horizon', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/predict?whaleId=wh_test&horizon=10y',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown pod with the canonical validation envelope', async () => {
    const response = await app.inject({
      headers: { 'x-request-id': 'invalid-pod-request' },
      method: 'GET',
      url: '/api/v1/predict?pod=Q&horizon=24h',
    });

    expect(response.statusCode).toBe(400);
    expect(SafeErrorSchema.parse(response.json())).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'The request is invalid.',
      requestId: 'invalid-pod-request',
      retryable: false,
    });
    expect(prisma.predictionGrid.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 when no prediction has been computed for the subject', async () => {
    vi.mocked(prisma.predictionGrid.findUnique).mockResolvedValue(null);
    
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/predict?whaleId=does-not-exist&horizon=24h',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns prediction cells when one is in the table', async () => {
    const mockGrid = {
      id: 'pred-123',
      subjectKind: 'WHALE' as const,
      subjectId: 'wh_predict_test_1',
      horizonHours: 24,
      cells: [
        { lat: 48.5, lng: -123.0, probability: 0.5 },
        { lat: 48.55, lng: -123.05, probability: 0.3 },
      ],
      confidence: '0.8' as unknown as Prisma.Decimal,
      modelVersion: 'markov-v1',
      computedAt: new Date('2026-05-01T10:00:00Z'),
    };
    
    vi.mocked(prisma.predictionGrid.findUnique).mockResolvedValue(mockGrid);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/predict?whaleId=wh_predict_test_1&horizon=24h',
    });
    expect(res.statusCode).toBe(200);
    const body = PredictionSchema.parse(res.json());
    expect(body.cells.length).toBe(2);
    expect(body.confidence).toBe(0.8);
    expect(body.modelVersion).toBe('markov-v1');
    expect(typeof body.computedAt).toBe('string');
    expect(res.headers.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/u);
    expect(res.headers['cache-control']).toContain('public');
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it('fails closed when stored prediction output violates the contract', async () => {
    vi.mocked(prisma.predictionGrid.findUnique).mockResolvedValue({
      id: 'pred-invalid',
      subjectKind: 'WHALE',
      subjectId: 'whale-invalid',
      horizonHours: 24,
      cells: [{ lat: 91, lng: -123, probability: 0.5 }],
      confidence: '0.8' as unknown as Prisma.Decimal,
      modelVersion: 'markov-v1',
      computedAt: new Date('2026-05-01T10:00:00Z'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/predict?whaleId=whale-invalid&horizon=24h',
    });

    expect(response.statusCode).toBe(500);
    expect(SafeErrorSchema.parse(response.json()).code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('"lat":91');
  });

  it('bounds a stalled database read with the canonical retryable response', async () => {
    vi.mocked(prisma.predictionGrid.findUnique).mockReturnValue(
      new Promise(() => undefined) as never,
    );
    const isolatedApp = await buildApp({ publicReadTimeoutMs: 25, silent: true });

    try {
      const response = await isolatedApp.inject({
        method: 'GET',
        url: '/api/v1/predict?whaleId=slow-whale&horizon=24h',
      });

      expect(response.statusCode).toBe(503);
      expect(SafeErrorSchema.parse(response.json())).toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
      });
    } finally {
      await isolatedApp.close();
    }
  });
});
