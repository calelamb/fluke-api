import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SafeErrorSchema,
  SightingFeedPageSchema,
} from '../contracts/index.js';
import {
  encodeFeedPageCursor,
  encodeFeedSyncCursor,
} from '../lib/feed-cursor.js';
import {
  removeExternalSightings,
  upsertExternalSightings,
  type ExternalSightingInput,
} from '../jobs/external-sighting-writer.js';

vi.mock('../db.js', () => {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ set_config: '5000ms' }]),
    externalSighting: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
    jobRunEvent: { findFirst: vi.fn() },
    sighting: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return {
    prisma: {
      ...transaction,
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => (
        callback(transaction)
      )),
    },
  };
});

const { prisma } = await import('../db.js');
const { buildApp } = await import('../app.js');

const observedAt = new Date('2026-07-18T18:00:00.000Z');

function internalRow(id: string, revision: bigint, status = 'APPROVED') {
  return {
    behaviorNotes: 'Traveling north',
    ecotypeGuess: 'RESIDENT',
    groupSize: 3,
    id,
    latitude: 48.5,
    locationName: 'Haro Strait',
    longitude: -123,
    moderatedAt: new Date('2026-07-18T19:00:00.000Z'),
    observedAt,
    observerEmail: 'private@example.test',
    observerName: 'Private Observer',
    photos: [{
      id: `photo-${id}`,
      orderIndex: 0,
      storageKey: `private/${id}`,
      thumbnailUrl: `https://fixtures.invalid/${id}-thumb.jpg`,
      url: `https://fixtures.invalid/${id}.jpg`,
    }],
    publicFeedRevision: revision,
    rejectionReason: 'private moderation note',
    status,
    whales: [{
      confidence: 'CONFIRMED',
      whale: { catalogId: 'J35', name: 'Tahlequah' },
    }],
  };
}

function externalRow(
  externalId: string,
  revision: bigint,
  date = observedAt,
  source = 'acartia',
) {
  return {
    attribution: 'Fixture provider',
    ecotypeGuess: 'UNKNOWN',
    externalId,
    fetchedAt: new Date('2026-07-18T19:00:00.000Z'),
    firstFetchedAt: new Date('2026-07-18T19:00:00.000Z'),
    groupSize: 4,
    id: `database-${externalId}`,
    latitude: 48.6,
    longitude: -123.1,
    notes: 'Provider observation',
    observedAt: date,
    publicFeedRemovedAt: null,
    publicFeedRevision: revision,
    source,
    sourceUrl: `https://fixtures.invalid/provider/${externalId}`,
    species: 'Orcinus orca',
    trusted: true,
    updatedAt: new Date('2026-07-18T19:00:00.000Z'),
  };
}

function configureHighWater(internal: bigint | null, external: bigint | null): void {
  vi.mocked(prisma.sighting.aggregate).mockResolvedValue({
    _max: { publicFeedRevision: internal },
  } as never);
  vi.mocked(prisma.externalSighting.aggregate).mockResolvedValue({
    _max: { publicFeedRevision: external },
  } as never);
}

describe('GET /api/v1/sighting-feed', () => {
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
    configureHighWater(9n, 10n);
    vi.mocked(prisma.sighting.findMany).mockResolvedValue([]);
    vi.mocked(prisma.externalSighting.findMany).mockResolvedValue([]);
    vi.mocked(prisma.jobRunEvent.findFirst)
      .mockResolvedValueOnce({
        event: 'FAILED',
        occurredAt: new Date('2026-07-18T18:05:00.000Z'),
      } as never)
      .mockResolvedValueOnce({
        event: 'STARTED',
        occurredAt: new Date('2026-07-18T18:00:00.000Z'),
      } as never)
      .mockResolvedValueOnce({
        occurredAt: new Date('2026-07-18T17:59:00.000Z'),
      } as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
  });

  it('is registered, returns a bounded stable history page, and excludes private fields', async () => {
    vi.mocked(prisma.sighting.findMany).mockResolvedValue([
      internalRow('internal-a', 9n),
    ] as never);
    vi.mocked(prisma.externalSighting.findMany).mockResolvedValue([
      externalRow('external-a', 10n),
    ] as never);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sighting-feed?limit=1',
    });

    expect(response.statusCode).toBe(200);
    const body = SightingFeedPageSchema.parse(response.json());
    expect(body.items.map((item) => item.id)).toEqual(['external:acartia:external-a']);
    expect(body.hasMore).toBe(true);
    expect(body.pageCursor).toBeTypeOf('string');
    expect(body.syncCursor).toBeTypeOf('string');
    expect(response.body).not.toContain('private@example.test');
    expect(response.body).not.toContain('Private Observer');
    expect(response.body).not.toContain('private moderation note');
    expect(response.body).not.toContain('private/internal-a');
    expect(response.body).not.toContain('APPROVED');
    expect(prisma.sighting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        whales: expect.objectContaining({
          orderBy: [{ whale: { catalogId: 'asc' } }, { whaleId: 'asc' }],
          take: 1_000,
        }),
      }),
      take: 2,
      where: expect.objectContaining({
        publicFeedRevision: { lte: 10n, not: null },
        status: 'APPROVED',
      }),
    }));
    expect(prisma.externalSighting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
      where: expect.objectContaining({
        publicFeedRemovedAt: null,
        publicFeedRevision: { lte: 10n, not: null },
      }),
    }));
  });

  it('syncs a late provider arrival by revision instead of observed time', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/v1/sighting-feed' });
    const initialPage = SightingFeedPageSchema.parse(initial.json());
    configureHighWater(9n, 11n);
    vi.mocked(prisma.externalSighting.findMany).mockResolvedValue([
      externalRow('late', 11n, new Date('2026-07-01T00:00:00.000Z')),
    ] as never);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(initialPage.syncCursor)}`,
    });

    expect(response.statusCode).toBe(200);
    const sync = SightingFeedPageSchema.parse(response.json());
    expect(sync.items.map((item) => item.id)).toEqual(['external:acartia:late']);
    expect(new Set(sync.items.map((item) => item.revision)).size).toBe(sync.items.length);
    expect(sync.pageCursor).toBeNull();
    expect(prisma.externalSighting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { publicFeedRevision: 'asc' },
      where: { publicFeedRevision: { gt: 10n, lte: 11n } },
    }));
  });

  it('fails closed on private media URLs while retaining public approved photos', async () => {
    const row = internalRow('media-filter', 9n);
    vi.mocked(prisma.sighting.findMany).mockResolvedValue([{
      ...row,
      photos: [
        ...row.photos,
        {
          id: 'private-photo',
          orderIndex: 1,
          storageKey: 'private/media-filter/original.jpg',
          thumbnailUrl: '/private/media-filter/thumb.jpg',
          url: '/private/media-filter/original.jpg',
        },
      ],
    }] as never);

    const response = await app.inject({ method: 'GET', url: '/api/v1/sighting-feed' });

    expect(response.statusCode).toBe(200);
    const body = SightingFeedPageSchema.parse(response.json());
    const item = body.items.find((candidate) => candidate.id === 'internal:media-filter');
    expect(item).toMatchObject({
      kind: 'internal',
      photos: [{ id: 'photo-media-filter' }],
    });
    expect(response.body).not.toContain('/private/media-filter');
  });

  it('returns only an ID and revision for approval reversals', async () => {
    configureHighWater(12n, 10n);
    vi.mocked(prisma.sighting.findMany).mockResolvedValue([
      internalRow('removed-internal', 12n, 'REJECTED'),
    ] as never);
    const cursor = encodeFeedSyncCursor(10n);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(cursor)}`,
    });

    const body = SightingFeedPageSchema.parse(response.json());
    expect(body.items).toEqual([{
      id: 'internal:removed-internal',
      kind: 'removed',
      revision: 12,
    }]);
  });

  it('encodes source-qualified external identities without delimiter collisions', async () => {
    configureHighWater(0n, 12n);
    vi.mocked(prisma.externalSighting.findMany).mockResolvedValue([
      externalRow('same', 11n, observedAt, 'provider:a'),
      externalRow('a:same', 12n, observedAt, 'provider'),
    ] as never);

    const response = await app.inject({ method: 'GET', url: '/api/v1/sighting-feed' });
    const body = SightingFeedPageSchema.parse(response.json());

    expect(body.items.map((item) => item.id)).toEqual([
      'external:provider:a%3Asame',
      'external:provider%3Aa:same',
    ]);
    expect(new Set(body.items.map((item) => item.id)).size).toBe(2);
  });

  it('accepts the longest valid Unicode provider identity without a response failure', async () => {
    const source = '\u0800'.repeat(100);
    const externalId = '\u0800'.repeat(200);
    configureHighWater(0n, 11n);
    vi.mocked(prisma.externalSighting.findMany).mockResolvedValue([
      externalRow(externalId, 11n, observedAt, source),
    ] as never);

    const response = await app.inject({ method: 'GET', url: '/api/v1/sighting-feed' });

    expect(response.statusCode, response.body).toBe(200);
    const [item] = SightingFeedPageSchema.parse(response.json()).items;
    expect(item?.id.length).toBe(2_710);
  });

  it('returns bounded provider freshness without operational secrets', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/sighting-feed' });

    const body = SightingFeedPageSchema.parse(response.json());
    expect(body.providers).toContainEqual({
      expectedMaximumLag: 25_200,
      lastAttemptAt: '2026-07-18T18:00:00.000Z',
      lastSuccessAt: '2026-07-18T17:59:00.000Z',
      provider: 'acartia',
      status: 'FAILED',
    });
    expect(JSON.stringify(body.providers)).not.toMatch(/runId|ownerToken|fence|errorCode/iu);
    expect(prisma.jobRunEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [
        { occurredAt: 'desc' },
        { fence: 'desc' },
        { runId: 'desc' },
        { event: 'desc' },
        { id: 'desc' },
      ],
    }));
  });

  it.each([
    '/api/v1/sighting-feed?limit=101',
    '/api/v1/sighting-feed?pageCursor=malformed',
    '/api/v1/sighting-feed?syncCursor=malformed',
    `/api/v1/sighting-feed?pageCursor=${encodeURIComponent(encodeFeedPageCursor({
      observedAt: observedAt.toISOString(),
      revision: 9n,
      snapshotRevision: 10n,
    }, 'wrong-secret'))}`,
    `/api/v1/sighting-feed?pageCursor=${encodeURIComponent(encodeFeedPageCursor({
      observedAt: observedAt.toISOString(),
      revision: 9n,
      snapshotRevision: 10n,
    }))}&syncCursor=${encodeURIComponent(encodeFeedSyncCursor(10n))}`,
  ])('rejects invalid or forged cursor input with a safe 400: %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect(SafeErrorSchema.parse(response.json()).code).toBe('VALIDATION_ERROR');
    expect(prisma.sighting.findMany).not.toHaveBeenCalled();
    expect(prisma.externalSighting.findMany).not.toHaveBeenCalled();
  });

  it('returns 304 when the validated feed representation matches the ETag', async () => {
    vi.mocked(prisma.jobRunEvent.findFirst).mockReset().mockResolvedValue(null);
    const first = await app.inject({ method: 'GET', url: '/api/v1/sighting-feed' });
    const etag = first.headers.etag;

    const second = await app.inject({
      headers: { 'if-none-match': etag },
      method: 'GET',
      url: '/api/v1/sighting-feed',
    });

    expect(etag).toBeTypeOf('string');
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });
});

describe('external feed revision writes', () => {
  const validInput = Object.freeze({
    attribution: 'Fixture provider',
    ecotypeGuess: null,
    externalId: 'fixture-external',
    groupSize: 2,
    latitude: 48.5,
    longitude: -123,
    notes: null,
    observedAt,
    source: 'fixture',
    sourceUrl: 'https://fixtures.invalid/external',
    species: 'Orcinus orca',
    trusted: true,
  }) satisfies ExternalSightingInput;

  it('validates stored provider data and bounds write batches before persistence', async () => {
    const upsert = vi.fn();
    const client = { externalSighting: { upsert } };

    await expect(upsertExternalSightings(client, [{
      ...validInput,
      sourceUrl: 'file:///private/provider-record',
    }], observedAt)).rejects.toThrow();
    await expect(upsertExternalSightings(
      client,
      Array.from({ length: 201 }, () => validInput),
      observedAt,
    )).rejects.toThrow('must not exceed 200');
    await expect(upsertExternalSightings(client, [validInput], new Date('invalid')))
      .rejects.toThrow('fetchedAt must be a valid date');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('persists maximum well-formed Unicode identities and rejects malformed Unicode', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const client = { externalSighting: { upsert } };
    await expect(upsertExternalSightings(client, [{
      ...validInput,
      externalId: '\u0800'.repeat(200),
      source: '\u0800'.repeat(100),
    }], observedAt)).resolves.toBe(1);
    await expect(upsertExternalSightings(client, [{
      ...validInput,
      externalId: '\uD800',
    }], observedAt)).rejects.toThrow('well-formed Unicode');
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('soft-removes a bounded unique provider identity set for tombstone sync', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const client = { externalSighting: { updateMany } };

    await expect(removeExternalSightings(
      client,
      'fixture',
      ['external-a', 'external-b'],
      observedAt,
    )).resolves.toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      data: { fetchedAt: observedAt, publicFeedRemovedAt: observedAt },
      where: {
        externalId: { in: ['external-a', 'external-b'] },
        publicFeedRemovedAt: null,
        source: 'fixture',
      },
    });
    await expect(removeExternalSightings(
      client,
      'fixture',
      ['duplicate', 'duplicate'],
      observedAt,
    )).rejects.toThrow('external IDs must be unique');
  });
});
