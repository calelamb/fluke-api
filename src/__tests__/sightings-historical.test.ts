import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HistoricalSightingPageSchema,
  SafeErrorSchema,
} from '../contracts/index.js';
import { encodeCursor } from '../lib/cursor.js';

vi.mock('../db.js', () => {
  const transactionClient = {
    $queryRaw: vi.fn().mockResolvedValue([{ set_config: '5000ms' }]),
    externalSighting: { findMany: vi.fn() },
    sighting: { findMany: vi.fn() },
  };
  return {
    prisma: {
      ...transactionClient,
      $transaction: vi.fn(async (callback: (client: typeof transactionClient) => unknown) =>
        callback(transactionClient)),
    },
  };
});

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

const observedAt = new Date('2026-07-16T18:00:00.000Z');

function internalRow(id: string) {
  return {
    ecotypeGuess: 'RESIDENT',
    id,
    latitude: 48.5,
    locationName: 'Haro Strait',
    longitude: -123,
    observedAt,
    whales: [{ whaleId: 'database-whale-j35' }],
  };
}

function externalRow(id: string) {
  return {
    ecotypeGuess: 'RESIDENT',
    id,
    latitude: 48.6,
    longitude: -123.1,
    observedAt,
  };
}

describe('GET /api/v1/sightings/historical', () => {
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
    vi.mocked(prisma.sighting.findMany).mockResolvedValue([]);
    vi.mocked(prisma.externalSighting.findMany).mockResolvedValue([]);
  });

  it('applies a bounded default date range and returns the page contract', async () => {
    const before = Date.now();
    vi.mocked(prisma.sighting.findMany).mockResolvedValue([internalRow('sighting-a')] as never);

    const response = await app.inject({ method: 'GET', url: '/api/v1/sightings/historical' });
    const after = Date.now();

    expect(response.statusCode).toBe(200);
    const page = HistoricalSightingPageSchema.parse(response.json());
    expect(page.items.map((item) => item.id)).toEqual(['sighting-a']);
    expect(page.page).toEqual({ hasMore: false, nextCursor: null });
    const query = vi.mocked(prisma.sighting.findMany).mock.calls[0][0];
    const range = query?.where?.observedAt;
    expect(range).toMatchObject({ gte: expect.any(Date), lte: expect.any(Date) });
    if (!range || range instanceof Date || typeof range === 'string') {
      throw new Error('expected date range filter');
    }
    const gte = range.gte as Date;
    const lte = range.lte as Date;
    expect(lte.getTime()).toBeGreaterThanOrEqual(before);
    expect(lte.getTime()).toBeLessThanOrEqual(after);
    expect(lte.getTime() - gte.getTime()).toBeLessThanOrEqual(366 * 24 * 60 * 60 * 1_000);
  });

  it('filters database and external rows by an explicit pod and bounded range', async () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-07-16T23:59:59.000Z';

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sightings/historical?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pod=J`,
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.sighting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'APPROVED',
        whales: { some: { whale: { pod: 'J' } } },
      }),
    }));
    expect(prisma.externalSighting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ecotypeGuess: 'RESIDENT' }),
    }));
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxWait: expect.any(Number), timeout: expect.any(Number) }),
    );
  });

  it('paginates a merged equal-timestamp boundary without duplicating source rows', async () => {
    vi.mocked(prisma.sighting.findMany)
      .mockResolvedValueOnce([internalRow('internal-a')] as never)
      .mockResolvedValueOnce([]);
    vi.mocked(prisma.externalSighting.findMany)
      .mockResolvedValueOnce([externalRow('external-a')] as never)
      .mockResolvedValueOnce([externalRow('external-a')] as never);

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/sightings/historical?limit=1',
    });
    const firstPage = HistoricalSightingPageSchema.parse(first.json());
    expect(firstPage.items.map((item) => item.id)).toEqual(['internal-a']);
    if (!firstPage.page.hasMore) throw new Error('expected next page');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/sightings/historical?limit=1&cursor=${encodeURIComponent(firstPage.page.nextCursor)}`,
    });
    const secondPage = HistoricalSightingPageSchema.parse(second.json());
    expect(secondPage.items.map((item) => item.id)).toEqual(['ext:external-a']);
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(2);
  });

  it.each([
    '/api/v1/sightings/historical?from=not-a-date',
    '/api/v1/sightings/historical?from=2026-07-17T00%3A00%3A00.000Z&to=2026-07-16T00%3A00%3A00.000Z',
    '/api/v1/sightings/historical?from=2024-01-01T00%3A00%3A00.000Z&to=2026-01-02T00%3A00%3A00.000Z',
    '/api/v1/sightings/historical?pod=Q',
    '/api/v1/sightings/historical?cursor=malformed',
    '/api/v1/sightings/historical?limit=101',
  ])('returns the safe 400 envelope for invalid query %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect(SafeErrorSchema.parse(response.json()).code).toBe('VALIDATION_ERROR');
    expect(prisma.sighting.findMany).not.toHaveBeenCalled();
    expect(prisma.externalSighting.findMany).not.toHaveBeenCalled();
  });

  it('rejects a forged cursor with an oversized historical window', async () => {
    const cursor = encodeCursor({
      from: '2020-01-01T00:00:00.000Z',
      id: 'internal-a',
      kind: 'historical-sightings',
      observedAt: '2026-07-16T18:00:00.000Z',
      pod: null,
      source: 'internal',
      to: '2026-07-16T23:59:59.000Z',
      version: 1,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sightings/historical?cursor=${encodeURIComponent(cursor)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(SafeErrorSchema.parse(response.json()).code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
