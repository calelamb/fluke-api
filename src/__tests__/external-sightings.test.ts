import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExternalSightingPageSchema,
  SafeErrorSchema,
} from '../contracts/index.js';
import { encodeCursor } from '../lib/cursor.js';

vi.mock('../db.js', () => ({
  prisma: {
    externalSighting: { findMany: vi.fn() },
  },
}));

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

const observedAt = new Date('2026-07-16T18:00:00.000Z');

function externalRow(id: string) {
  return {
    attribution: 'Fixture feed',
    ecotypeGuess: 'UNKNOWN',
    externalId: `observation-${id}`,
    fetchedAt: observedAt,
    groupSize: 3,
    id,
    latitude: 48.5,
    longitude: -123,
    notes: null,
    observedAt,
    source: 'fixture',
    sourceUrl: 'https://fixtures.invalid/observation',
    species: 'Orcinus orca',
    trusted: true,
  };
}

describe('GET /api/v1/external-sightings', () => {
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

  it('returns a bounded page and uses limit plus one', async () => {
    vi.mocked(prisma.externalSighting.findMany).mockResolvedValue([
      externalRow('external-b'),
      externalRow('external-a'),
    ] as never);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/external-sightings?limit=1&sinceDays=7&source=fixture',
    });

    expect(response.statusCode).toBe(200);
    const page = ExternalSightingPageSchema.parse(response.json());
    expect(page.items.map((item) => item.id)).toEqual(['external-b']);
    expect(page.page.hasMore).toBe(true);
    expect(prisma.externalSighting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: 2,
      where: expect.objectContaining({
        source: 'fixture',
        observedAt: { gte: expect.any(Date) },
      }),
    }));
  });

  it('uses the stable ID tie breaker for equal timestamps', async () => {
    vi.mocked(prisma.externalSighting.findMany)
      .mockResolvedValueOnce([externalRow('external-b'), externalRow('external-a')] as never)
      .mockResolvedValueOnce([externalRow('external-a')] as never);

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/external-sightings?limit=1&sinceDays=7',
    });
    const firstPage = ExternalSightingPageSchema.parse(first.json());
    if (!firstPage.page.hasMore) throw new Error('expected next page');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/external-sightings?limit=1&cursor=${encodeURIComponent(firstPage.page.nextCursor)}`,
    });

    expect(ExternalSightingPageSchema.parse(second.json()).items.map((item) => item.id))
      .toEqual(['external-a']);
    expect(prisma.externalSighting.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([{
          OR: [
            { observedAt: { lt: observedAt } },
            { observedAt, id: { lt: 'external-b' } },
          ],
        }]),
      }),
    }));
  });

  it.each([
    '/api/v1/external-sightings?limit=101',
    '/api/v1/external-sightings?cursor=malformed',
    '/api/v1/external-sightings?sinceDays=32',
  ])('rejects invalid query %s with a safe 400', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect(SafeErrorSchema.parse(response.json()).code).toBe('VALIDATION_ERROR');
    expect(prisma.externalSighting.findMany).not.toHaveBeenCalled();
  });

  it('rejects a forged cursor that expands the bounded source window', async () => {
    const cursor = encodeCursor({
      id: 'external-a',
      kind: 'external-sightings',
      observedAt: '2026-07-16T18:00:00.000Z',
      since: '2020-01-01T00:00:00.000Z',
      sinceDays: 7,
      source: null,
      version: 1,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/external-sightings?cursor=${encodeURIComponent(cursor)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(SafeErrorSchema.parse(response.json()).code).toBe('VALIDATION_ERROR');
    expect(prisma.externalSighting.findMany).not.toHaveBeenCalled();
  });
});
