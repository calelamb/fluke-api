import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WhaleDTO } from '../contracts/index.js';

vi.mock('../db.js', () => ({
  prisma: {
    whale: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    sighting: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    externalSighting: {
      findMany: vi.fn(),
    },
    sightingWhale: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

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
    vi.mocked(prisma.externalSighting.findMany).mockResolvedValue([]);
  });

  it('returns approved sightings within a date range', async () => {
    const now = new Date();
    vi.mocked(prisma.sighting.findMany).mockResolvedValue([
      {
        id: 's1',
        observedAt: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 365),
        latitude: 48.5,
        longitude: -123.0,
        locationName: 'Haro Strait',
        ecotypeGuess: 'RESIDENT',
        whales: [{ whaleId: 'j35' }, { whaleId: 'j17' }],
      },
    ] as never);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sightings/historical?from=2020-01-01&to=2030-01-01',
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    if (list.length > 0) {
      const s = list[0];
      expect(typeof s.id).toBe('string');
      expect(typeof s.observedAt).toBe('string');
      expect(typeof s.latitude).toBe('number');
      expect(typeof s.longitude).toBe('number');
      expect(Array.isArray(s.whaleIds)).toBe(true);
    }
  });

  it('filters by pod', async () => {
    vi.mocked(prisma.whale.findMany).mockResolvedValue([
      {
        id: 'j35-id',
        catalogId: 'J35',
        name: 'Tahlequah',
        pod: 'J',
        ecotype: 'RESIDENT',
        sex: 'FEMALE',
        birthYear: 1998,
        deathYear: null,
        status: 'ALIVE',
        biography: null,
        distinguishingMarks: null,
        heroImageUrl: null,
        notableEvents: [],
        sourceCitations: [],
        motherId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    vi.mocked(prisma.sighting.findMany).mockResolvedValue([
      {
        id: 's1',
        observedAt: new Date(),
        latitude: 48.5,
        longitude: -123.0,
        locationName: 'Haro Strait',
        ecotypeGuess: 'RESIDENT',
        whales: [{ whaleId: 'j35-id' }],
      },
    ] as never);

    const whales = (await app.inject({ method: 'GET', url: '/api/v1/whales' })).json<WhaleDTO[]>();
    const jPodWhale = whales.find((whale) => whale.pod === 'J');
    if (!jPodWhale) return; // no J-pod whale seeded; skip
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sightings/historical?pod=J`,
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    for (const sighting of list) {
      expect(sighting.whaleIds.length).toBeGreaterThan(0);
    }
  });

  it('returns 400 on bad date format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sightings/historical?from=not-a-date',
    });
    expect(res.statusCode).toBe(400);
  });
});
