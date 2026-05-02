import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    predictionGrid: {
      findUnique: vi.fn(),
    },
  },
}));

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

describe('GET /api/v1/predict', () => {
  let app: ReturnType<typeof import('../app.js').buildApp>;

  beforeAll(async () => {
    app = await import('../app.js').then((m) => m.buildApp({ silent: true }));
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
      confidence: 0.8,
      modelVersion: 'markov-v1',
      computedAt: new Date('2026-05-01T10:00:00Z'),
    };
    
    vi.mocked(prisma.predictionGrid.findUnique).mockResolvedValue(mockGrid);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/predict?whaleId=wh_predict_test_1&horizon=24h',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cells.length).toBe(2);
    expect(body.confidence).toBe(0.8);
    expect(body.modelVersion).toBe('markov-v1');
    expect(typeof body.computedAt).toBe('string');
  });
});
