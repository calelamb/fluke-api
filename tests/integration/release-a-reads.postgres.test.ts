import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExternalSightingPageSchema,
  HistoricalSightingPageSchema,
  SightingPageSchema,
  WhaleTrackSchema,
} from '../../src/contracts/index.js';
import { boundedDatabaseRead } from '../../src/lib/bounded-database-read.js';

const postgresEnabled = process.env.RUN_POSTGRES_INTEGRATION === 'true';
const fixture = Object.freeze({
  catalogId: 'IT-RELEASE-A-READS',
  externalIds: ['it-external-a', 'it-external-b'],
  observedAt: new Date(),
  sightingIds: ['it-sighting-a', 'it-sighting-b', 'it-sighting-c'],
  whaleId: 'it-whale-release-a-reads',
});

describe.runIf(postgresEnabled)('Release A reads against PostgreSQL', () => {
  let app: FastifyInstance;
  let prisma: typeof import('../../src/db.js')['prisma'];

  beforeAll(async () => {
    ({ prisma } = await import('../../src/db.js'));
    const { buildApp } = await import('../../src/app.js');

    await prisma.sighting.deleteMany({ where: { id: { in: [...fixture.sightingIds] } } });
    await prisma.externalSighting.deleteMany({ where: { id: { in: [...fixture.externalIds] } } });
    await prisma.whale.deleteMany({ where: { id: fixture.whaleId } });
    await prisma.whale.create({
      data: {
        catalogId: fixture.catalogId,
        ecotype: 'UNKNOWN',
        id: fixture.whaleId,
        name: 'Integration Test Whale',
      },
    });
    for (const id of fixture.sightingIds) {
      await prisma.sighting.create({
        data: {
          id,
          observedAt: fixture.observedAt,
          latitude: 48.5,
          longitude: -123,
          observerEmail: 'integration@example.invalid',
          status: 'APPROVED',
          whales: {
            create: { confidence: 'CONFIRMED', whaleId: fixture.whaleId },
          },
        },
      });
    }
    for (const id of fixture.externalIds) {
      await prisma.externalSighting.create({
        data: {
          attribution: 'Integration fixture',
          externalId: `provider-${id}`,
          id,
          latitude: 48.6,
          longitude: -123.1,
          observedAt: fixture.observedAt,
          source: 'integration',
          species: 'Orcinus orca',
          trusted: true,
        },
      });
    }

    app = await buildApp({
      features: Object.freeze({ accounts: false, identification: false, submissions: false }),
      silent: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.sighting.deleteMany({ where: { id: { in: [...fixture.sightingIds] } } });
      await prisma.externalSighting.deleteMany({ where: { id: { in: [...fixture.externalIds] } } });
      await prisma.whale.deleteMany({ where: { id: fixture.whaleId } });
      await prisma.$disconnect();
    }
  });

  it('paginates equal-timestamp sightings without duplicates or skips', async () => {
    const received: string[] = [];
    let cursor: string | null = null;

    do {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      const response = await app.inject({ method: 'GET', url: `/api/v1/sightings?${query}` });
      expect(response.statusCode).toBe(200);
      const page = SightingPageSchema.parse(response.json());
      const fixtureItems = page.items.filter((item) => fixture.sightingIds.includes(item.id));
      received.push(...fixtureItems.map((item) => item.id));
      cursor = page.page.nextCursor;
    } while (cursor && received.length < fixture.sightingIds.length);

    expect(received).toEqual([...fixture.sightingIds].sort().reverse());
    expect(new Set(received).size).toBe(fixture.sightingIds.length);
  });

  it('returns a canonical track by database whale ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/whales/${fixture.whaleId}/track`,
    });

    expect(response.statusCode).toBe(200);
    const track = WhaleTrackSchema.parse(response.json());
    expect(track.whaleId).toBe(fixture.whaleId);
    expect(track.catalogId).toBe(fixture.catalogId);
    expect(track.points.map((point) => point.id)).toEqual([...fixture.sightingIds].sort());
  });

  it('paginates equal-timestamp external sightings without duplicates or skips', async () => {
    const received: string[] = [];
    let cursor: string | null = null;

    do {
      const query = new URLSearchParams({ limit: '1', sinceDays: '7', source: 'integration' });
      if (cursor) query.set('cursor', cursor);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/external-sightings?${query}`,
      });
      expect(response.statusCode).toBe(200);
      const page = ExternalSightingPageSchema.parse(response.json());
      received.push(...page.items.map((item) => item.id));
      cursor = page.page.nextCursor;
    } while (cursor);

    expect(received).toEqual([...fixture.externalIds].sort().reverse());
    expect(new Set(received).size).toBe(fixture.externalIds.length);
  });

  it('paginates the merged historical tuple without duplicates or skips', async () => {
    const from = new Date(fixture.observedAt.getTime() - 60 * 60 * 1_000).toISOString();
    const to = new Date(fixture.observedAt.getTime() + 60 * 60 * 1_000).toISOString();
    const expected = [
      ...fixture.sightingIds,
      ...fixture.externalIds.map((id) => `ext:${id}`),
    ];
    const received: string[] = [];
    let cursor: string | null = null;

    do {
      const query = new URLSearchParams({
        from,
        limit: '1',
        to,
      });
      if (cursor) query.set('cursor', cursor);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/sightings/historical?${query}`,
      });
      expect(response.statusCode).toBe(200);
      const page = HistoricalSightingPageSchema.parse(response.json());
      received.push(...page.items.map((item) => item.id));
      cursor = page.page.nextCursor;
    } while (cursor);

    expect(received).toHaveLength(expected.length);
    expect(new Set(received)).toEqual(new Set(expected));
  });

  it('cancels stalled PostgreSQL work and releases the single pool connection', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const singleConnectionUrl = new URL(process.env.DATABASE_URL ?? '');
    singleConnectionUrl.searchParams.set('connection_limit', '1');
    singleConnectionUrl.searchParams.set('pool_timeout', '1');
    const isolatedPrisma = new PrismaClient({ datasourceUrl: singleConnectionUrl.toString() });
    const controller = new AbortController();
    const startedAt = Date.now();
    let markOperationStarted: (() => void) | undefined;
    const operationStarted = new Promise<void>((resolve) => {
      markOperationStarted = resolve;
    });

    try {
      const stalledRead = boundedDatabaseRead(
        isolatedPrisma,
        (transaction) => {
          markOperationStarted?.();
          return transaction.$queryRaw`SELECT pg_sleep(5)`;
        },
        controller.signal,
        75,
      );
      await operationStarted;
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort(new Error('integration client disconnected'));

      await expect(stalledRead).rejects.toThrow('integration client disconnected');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await expect(isolatedPrisma.$queryRaw`SELECT 1 AS value`).resolves.toEqual([{ value: 1 }]);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await isolatedPrisma.$disconnect();
    }
  });
});
