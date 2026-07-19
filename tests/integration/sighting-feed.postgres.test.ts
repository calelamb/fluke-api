import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ExternalSightingPageSchema,
  HistoricalSightingPageSchema,
  SightingFeedPageSchema,
} from '../../src/contracts/index.js';
import {
  removeExternalSightings,
  upsertExternalSightings,
} from '../../src/jobs/external-sighting-writer.js';
import { runAcartiaIngestion } from '../../src/jobs/ingestion-jobs.js';

const postgresEnabled = process.env.RUN_POSTGRES_INTEGRATION === 'true';
const repositoryRoot = new URL('../../', import.meta.url);
const migrationPath = new URL(
  'prisma/migrations/20260718130000_add_public_feed_revisions/migration.sql',
  repositoryRoot,
);

describe('public feed migration', () => {
  it('is additive and serializes revision assignment in commit order', () => {
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE SEQUENCE "public_feed_revision_seq" AS BIGINT');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('nextval(\'public_feed_revision_seq\')');
    expect(migration).toContain('public_feed_removed_at');
    expect(migration).toContain('pg_trigger_depth() > 1');
    expect(migration).toContain('revise_public_sightings_for_whale');
    expect(migration).not.toContain('external_sightings_external_id_key');
    expect(migration).not.toMatch(/^\s*(?:DELETE FROM|DROP TABLE|TRUNCATE)\b/mu);
  });
});

describe.runIf(postgresEnabled)('revisioned sighting feed against PostgreSQL', () => {
  const suffix = randomUUID();
  const fixture = Object.freeze({
    adminId: `feed-admin-${suffix}`,
    boundarySightingId: `feed-boundary-${suffix}`,
    boundaryWhalePrefix: `feed-boundary-whale-${suffix}`,
    callerRevisionSightingId: `feed-caller-revision-${suffix}`,
    collisionExternalId: `collision-${suffix}`,
    externalId: `late-${suffix}`,
    legacyRemovedExternalId: `legacy-removed-${suffix}`,
    legacyVisibleExternalId: `legacy-visible-${suffix}`,
    materialExternalId: `material-${suffix}`,
    photoId: `feed-photo-${suffix}`,
    reconcileExternalId: `reconcile-${suffix}`,
    sightingIds: [`feed-a-${suffix}`, `feed-b-${suffix}`],
    whaleCatalogId: `IT-${suffix}`,
    whaleId: `feed-whale-${suffix}`,
  });
  let app: FastifyInstance;
  let adminToken: string;
  let prisma: typeof import('../../src/db.js')['prisma'];

  beforeAll(async () => {
    ({ prisma } = await import('../../src/db.js'));
    const { buildApp } = await import('../../src/app.js');
    await prisma.user.create({
      data: { email: `${fixture.adminId}@example.invalid`, id: fixture.adminId, role: 'ADMIN' },
    });
    app = await buildApp({ silent: true });
    await app.ready();
    adminToken = app.jwt.sign({
      email: `${fixture.adminId}@example.invalid`,
      role: 'ADMIN',
      userId: fixture.adminId,
    });
  });

  beforeEach(async () => {
    await prisma.externalSighting.deleteMany({
      where: {
        externalId: {
          in: [
            fixture.collisionExternalId,
            fixture.externalId,
            fixture.legacyRemovedExternalId,
            fixture.legacyVisibleExternalId,
            fixture.materialExternalId,
            fixture.reconcileExternalId,
          ],
        },
      },
    });
    await prisma.sighting.deleteMany({
      where: {
        id: {
          in: [
            ...fixture.sightingIds,
            fixture.boundarySightingId,
            fixture.callerRevisionSightingId,
          ],
        },
      },
    });
    await prisma.whale.deleteMany({ where: { id: { startsWith: fixture.boundaryWhalePrefix } } });
    await prisma.whale.deleteMany({ where: { id: fixture.whaleId } });
    await prisma.whale.create({
      data: {
        catalogId: fixture.whaleCatalogId,
        ecotype: 'UNKNOWN',
        id: fixture.whaleId,
        name: 'Moderated integration whale',
      },
    });
    for (const id of fixture.sightingIds) {
      await prisma.sighting.create({
        data: {
          id,
          latitude: 48.5,
          longitude: -123,
          observedAt: new Date('2026-07-18T18:00:00.000Z'),
          observerEmail: `private-${id}@example.invalid`,
          status: 'PENDING',
        },
      });
    }
    await prisma.sighting.create({
      data: {
        id: fixture.callerRevisionSightingId,
        latitude: 48.5,
        longitude: -123,
        observedAt: new Date('2026-07-18T18:00:00.000Z'),
        observerEmail: 'private-caller-revision@example.invalid',
        publicFeedRevision: 999_999n,
        status: 'PENDING',
      },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!prisma) return;
    await prisma.externalSighting.deleteMany({
      where: {
        externalId: {
          in: [
            fixture.collisionExternalId,
            fixture.externalId,
            fixture.legacyRemovedExternalId,
            fixture.legacyVisibleExternalId,
            fixture.materialExternalId,
            fixture.reconcileExternalId,
          ],
        },
      },
    });
    await prisma.sighting.deleteMany({
      where: {
        id: {
          in: [
            ...fixture.sightingIds,
            fixture.boundarySightingId,
            fixture.callerRevisionSightingId,
          ],
        },
      },
    });
    await prisma.whale.deleteMany({ where: { id: { startsWith: fixture.boundaryWhalePrefix } } });
    await prisma.whale.deleteMany({ where: { id: fixture.whaleId } });
    await prisma.user.deleteMany({ where: { id: fixture.adminId } });
    await prisma.$disconnect();
  });

  it('prevents callers from assigning public revisions', async () => {
    const pending = await prisma.sighting.findUniqueOrThrow({
      where: { id: fixture.callerRevisionSightingId },
    });
    expect(pending.publicFeedRevision).toBeNull();
  });

  it('paginates equal observed times and syncs late arrivals without duplicates', async () => {
    for (const id of fixture.sightingIds) {
      const approved = await app.inject({
        cookies: { fluke_admin: adminToken },
        method: 'POST',
        url: `/api/v1/admin/sightings/${id}/approve`,
      });
      expect(approved.statusCode).toBe(200);
    }

    const approved = await prisma.sighting.findUniqueOrThrow({
      where: { id: fixture.sightingIds[0] },
    });
    await prisma.sighting.update({
      data: { publicFeedRevision: 999_999n },
      where: { id: fixture.sightingIds[0] },
    });
    const tampered = await prisma.sighting.findUniqueOrThrow({
      where: { id: fixture.sightingIds[0] },
    });
    expect(tampered.publicFeedRevision).toBe(approved.publicFeedRevision);

    const seen = new Set<string>();
    let pageCursor: string | null = null;
    let syncCursor = '';
    do {
      const query = new URLSearchParams({ limit: '1' });
      if (pageCursor) query.set('pageCursor', pageCursor);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/sighting-feed?${query}`,
      });
      expect(response.statusCode).toBe(200);
      const page = SightingFeedPageSchema.parse(response.json());
      page.items
        .filter((item) => fixture.sightingIds.some((id) => item.id === `internal:${id}`))
        .forEach((item) => seen.add(item.id));
      pageCursor = page.pageCursor;
      syncCursor ||= page.syncCursor;
    } while (pageCursor && seen.size < fixture.sightingIds.length);
    expect(seen.size).toBe(fixture.sightingIds.length);

    await prisma.$transaction(async (transaction) => {
      await upsertExternalSightings(transaction, [{
        attribution: 'Integration provider',
        ecotypeGuess: null,
        externalId: fixture.externalId,
        groupSize: null,
        latitude: 48.6,
        longitude: -123.1,
        notes: null,
        observedAt: new Date('2026-07-01T00:00:00.000Z'),
        source: 'integration',
        sourceUrl: null,
        species: 'Orcinus orca',
        trusted: true,
      }], new Date());
    });

    const sync = await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(syncCursor)}`,
    });
    const syncPage = SightingFeedPageSchema.parse(sync.json());
    expect(syncPage.items.map((item) => item.id))
      .toContain(`external:integration:${fixture.externalId}`);
    expect(new Set(syncPage.items.map((item) => item.revision)).size)
      .toBe(syncPage.items.length);
  });

  it('keeps the same raw external ID distinct across providers', async () => {
    const external = Object.freeze({
      attribution: 'Collision provider',
      ecotypeGuess: null,
      externalId: fixture.collisionExternalId,
      groupSize: null,
      latitude: 48.6,
      longitude: -123.1,
      notes: null,
      observedAt: new Date('2026-07-03T00:00:00.000Z'),
      sourceUrl: null,
      species: 'Orcinus orca',
      trusted: true,
    });
    await prisma.$transaction((transaction) => upsertExternalSightings(
      transaction,
      [{ ...external, source: 'collision-a' }],
      new Date(),
    ));

    await prisma.$transaction((transaction) => upsertExternalSightings(
      transaction,
      [{ ...external, source: 'collision-b' }],
      new Date(),
    ));

    const page = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: '/api/v1/sighting-feed',
    })).json());
    expect(page.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      `external:collision-a:${fixture.collisionExternalId}`,
      `external:collision-b:${fixture.collisionExternalId}`,
    ]));
  });

  it('excludes soft-removed provider rows from legacy public routes', async () => {
    const observedAt = new Date('2026-07-18T12:00:00.000Z');
    const base = Object.freeze({
      attribution: 'Integration provider',
      ecotypeGuess: null,
      groupSize: null,
      latitude: 48.6,
      longitude: -123.1,
      notes: null,
      observedAt,
      source: 'integration',
      sourceUrl: null,
      species: 'Orcinus orca',
      trusted: true,
    });
    await prisma.$transaction((transaction) => upsertExternalSightings(transaction, [
      { ...base, externalId: fixture.legacyRemovedExternalId },
      { ...base, externalId: fixture.legacyVisibleExternalId },
    ], new Date()));
    await prisma.$transaction((transaction) => removeExternalSightings(
      transaction,
      'integration',
      [fixture.legacyRemovedExternalId],
      new Date(),
    ));
    const removed = await prisma.externalSighting.findUniqueOrThrow({
      where: {
        source_externalId: {
          externalId: fixture.legacyRemovedExternalId,
          source: 'integration',
        },
      },
    });
    const visible = await prisma.externalSighting.findUniqueOrThrow({
      where: {
        source_externalId: {
          externalId: fixture.legacyVisibleExternalId,
          source: 'integration',
        },
      },
    });

    const externalPage = ExternalSightingPageSchema.parse((await app.inject({
      method: 'GET',
      url: '/api/v1/external-sightings?sinceDays=31&source=integration',
    })).json());
    expect(externalPage.items.map((item) => item.externalId))
      .toContain(fixture.legacyVisibleExternalId);
    expect(externalPage.items.map((item) => item.externalId))
      .not.toContain(fixture.legacyRemovedExternalId);

    const historicalPage = HistoricalSightingPageSchema.parse((await app.inject({
      method: 'GET',
      url: '/api/v1/sightings/historical?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-19T23%3A59%3A59.000Z',
    })).json());
    expect(historicalPage.items.map((item) => item.id)).toContain(`ext:${visible.id}`);
    expect(historicalPage.items.map((item) => item.id)).not.toContain(`ext:${removed.id}`);
  });

  it('orders equal-timestamp provider status by run fence and terminal event', async () => {
    const occurredAt = new Date('2099-07-18T18:00:00.000Z');
    const fence = 9_000_000_000_000n + BigInt(Date.now());
    const latestRunId = `freshness-latest-${suffix}`;
    const priorRunId = `freshness-prior-${suffix}`;
    await prisma.jobRunEvent.createMany({
      data: [
        {
          event: 'STARTED', fence: fence - 1n, jobName: 'acartia-ingest',
          occurredAt, runId: priorRunId,
        },
        {
          event: 'SUCCEEDED', fence: fence - 1n, jobName: 'acartia-ingest',
          occurredAt, runId: priorRunId,
        },
        {
          event: 'STARTED', fence, jobName: 'acartia-ingest', occurredAt, runId: latestRunId,
        },
        {
          event: 'FAILED', fence, jobName: 'acartia-ingest', occurredAt, runId: latestRunId,
        },
      ],
    });

    const page = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: '/api/v1/sighting-feed',
    })).json());
    expect(page.providers).toContainEqual(expect.objectContaining({
      lastAttemptAt: occurredAt.toISOString(),
      lastSuccessAt: occurredAt.toISOString(),
      provider: 'acartia',
      status: 'FAILED',
    }));
  });

  it('reconciles a successful authoritative provider snapshot without crossing sources', async () => {
    const observedAt = new Date();
    const record = Object.freeze({
      attribution: 'Reconciliation provider',
      ecotypeGuess: null,
      externalId: fixture.reconcileExternalId,
      groupSize: null,
      latitude: 48.6,
      longitude: -123.1,
      notes: null,
      observedAt,
      sourceUrl: null,
      species: 'Orcinus orca',
      trusted: true,
    });
    await prisma.$transaction((transaction) => upsertExternalSightings(transaction, [
      { ...record, source: 'acartia' },
      { ...record, source: 'other-provider' },
    ], new Date(Date.now() - 60_000)));
    const otherBefore = await prisma.externalSighting.findUniqueOrThrow({
      where: {
        source_externalId: {
          externalId: fixture.reconcileExternalId,
          source: 'other-provider',
        },
      },
    });
    const before = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: '/api/v1/sighting-feed',
    })).json());
    const lease = Object.freeze({
      fence: 1n,
      jobName: 'acartia-ingest',
      ownerToken: `owner-${suffix}`,
      runId: `reconcile-run-${suffix}`,
    });
    const store = {
      runFenced: <T>(
        _lease: typeof lease,
        operation: (transaction: Prisma.TransactionClient) => Promise<T>,
      ) => prisma.$transaction((transaction) => operation(transaction)),
    };

    await runAcartiaIngestion({
      fetchSightings: async () => ({
        reconciliation: {
          authoritative: true,
          observedFrom: new Date(observedAt.getTime() - 60_000),
          observedTo: new Date(observedAt.getTime() + 60_000),
          seenExternalIds: [],
          source: 'acartia',
        },
        sightings: [],
      }),
      lease,
      signal: new AbortController().signal,
      store,
    });

    const removed = await prisma.externalSighting.findUniqueOrThrow({
      where: {
        source_externalId: {
          externalId: fixture.reconcileExternalId,
          source: 'acartia',
        },
      },
    });
    const otherAfter = await prisma.externalSighting.findUniqueOrThrow({
      where: {
        source_externalId: {
          externalId: fixture.reconcileExternalId,
          source: 'other-provider',
        },
      },
    });
    expect(removed.publicFeedRemovedAt).not.toBeNull();
    expect(otherAfter.publicFeedRemovedAt).toBeNull();
    expect(otherAfter.publicFeedRevision).toBe(otherBefore.publicFeedRevision);
    const sync = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(before.syncCursor)}`,
    })).json());
    expect(sync.items).toContainEqual(expect.objectContaining({
      id: `external:acartia:${fixture.reconcileExternalId}`,
      kind: 'removed',
    }));

    await prisma.$transaction((transaction) => upsertExternalSightings(
      transaction,
      [{ ...record, source: 'acartia' }],
      new Date(),
    ));
    const restored = await prisma.externalSighting.findUniqueOrThrow({
      where: {
        source_externalId: {
          externalId: fixture.reconcileExternalId,
          source: 'acartia',
        },
      },
    });
    await expect(runAcartiaIngestion({
      fetchSightings: async () => {
        throw new Error('authoritative fetch failed');
      },
      lease,
      signal: new AbortController().signal,
      store,
    })).rejects.toThrow('authoritative fetch failed');
    const afterFailure = await prisma.externalSighting.findUniqueOrThrow({
      where: {
        source_externalId: {
          externalId: fixture.reconcileExternalId,
          source: 'acartia',
        },
      },
    });
    expect(afterFailure.publicFeedRemovedAt).toBeNull();
    expect(afterFailure.publicFeedRevision).toBe(restored.publicFeedRevision);
  });

  it('returns the same catalog-ordered whale boundary across repeated reads', async () => {
    const whaleCount = 1_001;
    const whaleRows = Array.from({ length: whaleCount }, (_, index) => ({
      catalogId: `BOUND-${String(whaleCount - 1 - index).padStart(4, '0')}`,
      ecotype: 'UNKNOWN' as const,
      id: `${fixture.boundaryWhalePrefix}-${String(index).padStart(4, '0')}`,
    }));
    await prisma.whale.createMany({ data: whaleRows });
    await prisma.sighting.create({
      data: {
        id: fixture.boundarySightingId,
        latitude: 48.5,
        longitude: -123,
        observedAt: new Date('2026-07-18T18:00:00.000Z'),
        observerEmail: 'private-boundary@example.invalid',
        status: 'APPROVED',
      },
    });
    await prisma.sightingWhale.createMany({
      data: whaleRows.map((whale) => ({
        confidence: 'CONFIRMED' as const,
        sightingId: fixture.boundarySightingId,
        whaleId: whale.id,
      })),
    });

    const readCatalogIds = async () => {
      const page = SightingFeedPageSchema.parse((await app.inject({
        method: 'GET',
        url: '/api/v1/sighting-feed',
      })).json());
      const item = page.items.find((candidate) => (
        candidate.id === `internal:${fixture.boundarySightingId}`
      ));
      if (item?.kind !== 'internal') throw new Error('boundary sighting missing');
      return item.identifiedWhales.map((whale) => whale.catalogId);
    };
    const expected = whaleRows.map((whale) => whale.catalogId).sort().slice(0, 1_000);

    const first = await readCatalogIds();
    const second = await readCatalogIds();

    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(first).toHaveLength(1_000);
  });

  it('revises an approved sighting once for a material moderated identity change', async () => {
    const approved = await app.inject({
      cookies: { fluke_admin: adminToken },
      method: 'POST',
      url: `/api/v1/admin/sightings/${fixture.sightingIds[1]}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    const before = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: '/api/v1/sighting-feed',
    })).json());
    const link = async () => app.inject({
      cookies: { fluke_admin: adminToken },
      method: 'POST',
      payload: { catalogId: fixture.whaleCatalogId, confidence: 'CONFIRMED' },
      url: `/api/v1/admin/sightings/${fixture.sightingIds[1]}/link-whale`,
    });
    expect((await link()).statusCode).toBe(200);

    const changed = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(before.syncCursor)}`,
    })).json());
    expect(changed.items).toContainEqual(expect.objectContaining({
      id: `internal:${fixture.sightingIds[1]}`,
      identifiedWhales: [expect.objectContaining({ catalogId: fixture.whaleCatalogId })],
      kind: 'internal',
    }));

    expect((await link()).statusCode).toBe(200);
    const replay = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(changed.syncCursor)}`,
    })).json());
    expect(replay.items).not.toContainEqual(expect.objectContaining({
      id: `internal:${fixture.sightingIds[1]}`,
    }));

    const linkedBeforeNonPublicUpdate = await prisma.sighting.findUniqueOrThrow({
      where: { id: fixture.sightingIds[1] },
    });
    await prisma.sightingWhale.update({
      data: { mlScore: 0.98 },
      where: {
        sightingId_whaleId: {
          sightingId: fixture.sightingIds[1],
          whaleId: fixture.whaleId,
        },
      },
    });
    const linkedAfterNonPublicUpdate = await prisma.sighting.findUniqueOrThrow({
      where: { id: fixture.sightingIds[1] },
    });
    expect(linkedAfterNonPublicUpdate.publicFeedRevision)
      .toBe(linkedBeforeNonPublicUpdate.publicFeedRevision);

    await prisma.sightingPhoto.create({
      data: {
        id: fixture.photoId,
        orderIndex: 0,
        sightingId: fixture.sightingIds[1],
        storageKey: `private/${fixture.photoId}`,
        thumbnailUrl: 'https://cdn.example.invalid/feed-thumb.jpg',
        url: 'https://cdn.example.invalid/feed.jpg',
      },
    });
    const linkedBeforeProcessingUpdate = await prisma.sighting.findUniqueOrThrow({
      where: { id: fixture.sightingIds[1] },
    });
    await prisma.sightingPhoto.update({
      data: { done: true },
      where: { id: fixture.photoId },
    });
    const linkedAfterProcessingUpdate = await prisma.sighting.findUniqueOrThrow({
      where: { id: fixture.sightingIds[1] },
    });
    expect(linkedAfterProcessingUpdate.publicFeedRevision)
      .toBe(linkedBeforeProcessingUpdate.publicFeedRevision);

    await prisma.whale.update({
      data: { name: 'Renamed integration whale' },
      where: { id: fixture.whaleId },
    });
    const renamed = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(replay.syncCursor)}`,
    })).json());
    expect(renamed.items).toContainEqual(expect.objectContaining({
      id: `internal:${fixture.sightingIds[1]}`,
      identifiedWhales: [expect.objectContaining({ name: 'Renamed integration whale' })],
      kind: 'internal',
    }));
  });

  it('collapses multiple material writes in one transaction to one final sync item', async () => {
    const before = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: '/api/v1/sighting-feed',
    })).json());
    const base = Object.freeze({
      attribution: 'Integration provider',
      ecotypeGuess: null,
      externalId: fixture.materialExternalId,
      latitude: 48.6,
      longitude: -123.1,
      notes: null,
      observedAt: new Date('2026-07-02T00:00:00.000Z'),
      source: 'integration',
      sourceUrl: null,
      species: 'Orcinus orca',
      trusted: true,
    });
    await prisma.$transaction(async (transaction) => {
      await upsertExternalSightings(transaction, [{ ...base, groupSize: 1 }], new Date());
      await upsertExternalSightings(transaction, [{ ...base, groupSize: 2 }], new Date());
    });

    const firstSync = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(before.syncCursor)}`,
    })).json());
    const matching = firstSync.items.filter(
      (item) => item.id === `external:integration:${fixture.materialExternalId}`,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ groupSize: 2, kind: 'external' });

    await prisma.$transaction((transaction) => upsertExternalSightings(
      transaction,
      [{ ...base, groupSize: 2 }],
      new Date(Date.now() + 1_000),
    ));
    const unchanged = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(firstSync.syncCursor)}`,
    })).json());
    expect(unchanged.items).not.toContainEqual(expect.objectContaining({
      id: `external:integration:${fixture.materialExternalId}`,
    }));
  });

  it('advances across rollback gaps and emits minimal internal and external tombstones', async () => {
    const approved = await app.inject({
      cookies: { fluke_admin: adminToken },
      method: 'POST',
      url: `/api/v1/admin/sightings/${fixture.sightingIds[0]}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    await prisma.$transaction((transaction) => upsertExternalSightings(transaction, [{
      attribution: 'Integration provider',
      ecotypeGuess: null,
      externalId: fixture.externalId,
      groupSize: null,
      latitude: 48.6,
      longitude: -123.1,
      notes: null,
      observedAt: new Date('2026-07-01T00:00:00.000Z'),
      source: 'integration',
      sourceUrl: null,
      species: 'Orcinus orca',
      trusted: true,
    }], new Date()));
    const before = SightingFeedPageSchema.parse((await app.inject({
      method: 'GET',
      url: '/api/v1/sighting-feed',
    })).json());

    await expect(prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(731864212)`;
      await transaction.$queryRaw`SELECT nextval('public_feed_revision_seq')`;
      throw new Error('intentional rollback gap');
    })).rejects.toThrow('intentional rollback gap');

    const rejected = await app.inject({
      cookies: { fluke_admin: adminToken },
      method: 'POST',
      payload: { reason: 'Integration reversal' },
      url: `/api/v1/admin/sightings/${fixture.sightingIds[0]}/reject`,
    });
    expect(rejected.statusCode).toBe(200);
    await prisma.$transaction((transaction) => removeExternalSightings(
      transaction,
      'integration',
      [fixture.externalId],
      new Date(),
    ));

    const changesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/sighting-feed?syncCursor=${encodeURIComponent(before.syncCursor)}`,
    });
    expect(changesResponse.statusCode, changesResponse.body).toBe(200);
    const changes = SightingFeedPageSchema.parse(changesResponse.json());
    expect(changes.items).toEqual(expect.arrayContaining([
      {
        id: `internal:${fixture.sightingIds[0]}`,
        kind: 'removed',
        revision: expect.any(Number),
      },
      {
        id: `external:integration:${fixture.externalId}`,
        kind: 'removed',
        revision: expect.any(Number),
      },
    ]));
    expect(changes.items.every((item) => item.revision > 0)).toBe(true);
  });
});
