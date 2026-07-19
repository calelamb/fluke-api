import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import {
  type Ecotype,
  type IdConfidence,
  type ProviderFreshness,
  type SightingFeedItem,
  SightingFeedPageSchema,
  SightingPhotoSchema,
  SightingFeedQuerySchema,
} from '../contracts/index.js';
import { prisma } from '../db.js';
import {
  boundedDatabaseRead,
  type BoundedReadRouteOptions,
} from '../lib/bounded-database-read.js';
import { InvalidCursorError } from '../lib/cursor.js';
import {
  decodeFeedPageCursor,
  decodeFeedSyncCursor,
  encodeFeedPageCursor,
  encodeFeedSyncCursor,
} from '../lib/feed-cursor.js';
import { LIVE_READ_CACHE_POLICY, sendPublicResponse } from '../lib/public-response.js';
import { externalPublicFeedId } from '../lib/public-feed-id.js';

const MAX_NESTED_FEED_ITEMS = 1_000;
const PROVIDERS = Object.freeze([
  Object.freeze({
    expectedMaximumLag: 7 * 60 * 60,
    jobName: 'acartia-ingest',
    provider: 'acartia' as const,
  }),
  Object.freeze({
    expectedMaximumLag: 8 * 24 * 60 * 60,
    jobName: 'gbif-ingest',
    provider: 'gbif' as const,
  }),
]);
const LATEST_EVENT_ORDER = Object.freeze([
  Object.freeze({ occurredAt: 'desc' as const }),
  Object.freeze({ fence: 'desc' as const }),
  Object.freeze({ runId: 'desc' as const }),
  Object.freeze({ event: 'desc' as const }),
  Object.freeze({ id: 'desc' as const }),
]);

interface InternalFeedRow {
  readonly behaviorNotes: string | null;
  readonly ecotypeGuess: Ecotype | null;
  readonly groupSize: number | null;
  readonly id: string;
  readonly latitude: unknown;
  readonly locationName: string | null;
  readonly longitude: unknown;
  readonly observedAt: Date;
  readonly photos: readonly {
    readonly id: string;
    readonly orderIndex: number;
    readonly thumbnailUrl: string;
    readonly url: string;
  }[];
  readonly publicFeedRevision: bigint | null;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED';
  readonly whales: readonly {
    readonly confidence: IdConfidence;
    readonly whale: { readonly catalogId: string; readonly name: string | null };
  }[];
}

interface ExternalFeedRow {
  readonly attribution: string;
  readonly ecotypeGuess: Ecotype | null;
  readonly externalId: string;
  readonly groupSize: number | null;
  readonly latitude: unknown;
  readonly longitude: unknown;
  readonly notes: string | null;
  readonly observedAt: Date;
  readonly publicFeedRemovedAt: Date | null;
  readonly publicFeedRevision: bigint | null;
  readonly source: string;
  readonly sourceUrl: string | null;
  readonly species: string;
  readonly trusted: boolean;
}

type FeedRow = Readonly<{
  entity: 'external';
  row: ExternalFeedRow;
}> | Readonly<{
  entity: 'internal';
  row: InternalFeedRow;
}>;

interface HistoryRead {
  readonly kind: 'history';
  readonly cursor: ReturnType<typeof decodeFeedPageCursor> | null;
  readonly limit: number;
}

interface SyncRead {
  readonly kind: 'sync';
  readonly cursorRevision: bigint;
  readonly limit: number;
}

type FeedRead = HistoryRead | SyncRead;

const nestedRelations = Object.freeze({
  photos: {
    orderBy: { orderIndex: 'asc' as const },
    take: MAX_NESTED_FEED_ITEMS,
  },
  whales: {
    include: { whale: { select: { catalogId: true, name: true } } },
    orderBy: [{ whale: { catalogId: 'asc' as const } }, { whaleId: 'asc' as const }],
    take: MAX_NESTED_FEED_ITEMS,
  },
});

function resolveRead(input: unknown): FeedRead {
  const query = SightingFeedQuerySchema.safeParse(input);
  if (!query.success) throw new InvalidCursorError();
  if (query.data.syncCursor) {
    return Object.freeze({
      cursorRevision: decodeFeedSyncCursor(query.data.syncCursor),
      kind: 'sync' as const,
      limit: query.data.limit,
    });
  }
  return Object.freeze({
    cursor: query.data.pageCursor ? decodeFeedPageCursor(query.data.pageCursor) : null,
    kind: 'history' as const,
    limit: query.data.limit,
  });
}

function safeRevision(value: bigint | null): bigint {
  if (value === null || value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Stored public feed revision is invalid');
  }
  return value;
}

function publicRevision(value: bigint | null): number {
  return Number(safeRevision(value));
}

function rowRevision(row: FeedRow): bigint {
  return safeRevision(row.row.publicFeedRevision);
}

function rowObservedAt(row: FeedRow): Date {
  return row.row.observedAt;
}

function compareHistory(left: FeedRow, right: FeedRow): number {
  const observedDifference = right.row.observedAt.getTime() - left.row.observedAt.getTime();
  if (observedDifference !== 0) return observedDifference;
  const revisionDifference = rowRevision(right) - rowRevision(left);
  return revisionDifference > 0n ? 1 : revisionDifference < 0n ? -1 : 0;
}

function compareSync(left: FeedRow, right: FeedRow): number {
  const revisionDifference = rowRevision(left) - rowRevision(right);
  return revisionDifference > 0n ? 1 : revisionDifference < 0n ? -1 : 0;
}

function internalItem(row: InternalFeedRow): SightingFeedItem {
  const revision = publicRevision(row.publicFeedRevision);
  if (row.status !== 'APPROVED') {
    return Object.freeze({ id: `internal:${row.id}`, kind: 'removed', revision });
  }
  return Object.freeze({
    behaviorNotes: row.behaviorNotes,
    ecotypeGuess: row.ecotypeGuess,
    groupSize: row.groupSize,
    id: `internal:${row.id}`,
    identifiedWhales: row.whales.map((link) => Object.freeze({
      catalogId: link.whale.catalogId,
      confidence: link.confidence,
      name: link.whale.name,
    })),
    kind: 'internal',
    latitude: Number(row.latitude),
    locationName: row.locationName,
    longitude: Number(row.longitude),
    observedAt: row.observedAt.toISOString(),
    photos: row.photos.flatMap((photo) => {
      const parsed = SightingPhotoSchema.safeParse({
        id: photo.id,
        orderIndex: photo.orderIndex,
        thumbnailUrl: photo.thumbnailUrl,
        url: photo.url,
      });
      return parsed.success ? [Object.freeze(parsed.data)] : [];
    }),
    revision,
  });
}

function externalItem(row: ExternalFeedRow): SightingFeedItem {
  const revision = publicRevision(row.publicFeedRevision);
  const id = externalPublicFeedId(row.source, row.externalId);
  if (row.publicFeedRemovedAt !== null) {
    return Object.freeze({ id, kind: 'removed', revision });
  }
  return Object.freeze({
    attribution: row.attribution,
    ecotypeGuess: row.ecotypeGuess,
    groupSize: row.groupSize,
    id,
    kind: 'external',
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    notes: row.notes,
    observedAt: row.observedAt.toISOString(),
    revision,
    source: row.source,
    sourceUrl: row.sourceUrl,
    species: row.species,
    trusted: row.trusted,
  });
}

function toItem(row: FeedRow): SightingFeedItem {
  return row.entity === 'internal' ? internalItem(row.row) : externalItem(row.row);
}

function historyWhere(
  snapshotRevision: bigint,
  cursor: HistoryRead['cursor'],
  internal: boolean,
): Prisma.SightingWhereInput | Prisma.ExternalSightingWhereInput {
  const base = {
    publicFeedRevision: { lte: snapshotRevision, not: null },
    ...(internal ? { status: 'APPROVED' as const } : { publicFeedRemovedAt: null }),
  };
  if (!cursor) return base;
  const observedAt = new Date(cursor.observedAt);
  return {
    AND: [base, {
      OR: [
        { observedAt: { lt: observedAt } },
        { observedAt, publicFeedRevision: { lt: cursor.revision } },
      ],
    }],
  };
}

async function providerFreshness(
  transaction: Prisma.TransactionClient,
): Promise<readonly ProviderFreshness[]> {
  return Promise.all(PROVIDERS.map(async (definition) => {
    const [latest, attempt, success] = await Promise.all([
      transaction.jobRunEvent.findFirst({
        orderBy: [...LATEST_EVENT_ORDER],
        select: { event: true },
        where: { jobName: definition.jobName },
      }),
      transaction.jobRunEvent.findFirst({
        orderBy: [...LATEST_EVENT_ORDER],
        select: { occurredAt: true },
        where: { event: 'STARTED', jobName: definition.jobName },
      }),
      transaction.jobRunEvent.findFirst({
        orderBy: [...LATEST_EVENT_ORDER],
        select: { occurredAt: true },
        where: { event: 'SUCCEEDED', jobName: definition.jobName },
      }),
    ]);
    return Object.freeze({
      expectedMaximumLag: definition.expectedMaximumLag,
      lastAttemptAt: attempt?.occurredAt.toISOString() ?? null,
      lastSuccessAt: success?.occurredAt.toISOString() ?? null,
      provider: definition.provider,
      status: latest?.event ?? 'NEVER_RUN',
    });
  }));
}

async function highWater(transaction: Prisma.TransactionClient): Promise<bigint> {
  const [internal, external] = await Promise.all([
    transaction.sighting.aggregate({ _max: { publicFeedRevision: true } }),
    transaction.externalSighting.aggregate({ _max: { publicFeedRevision: true } }),
  ]);
  const internalRevision = internal._max.publicFeedRevision ?? 0n;
  const externalRevision = external._max.publicFeedRevision ?? 0n;
  return internalRevision > externalRevision ? internalRevision : externalRevision;
}

async function readRows(
  transaction: Prisma.TransactionClient,
  read: FeedRead,
  snapshotRevision: bigint,
): Promise<readonly FeedRow[]> {
  const take = read.limit + 1;
  if (read.kind === 'sync') {
    const where = { publicFeedRevision: { gt: read.cursorRevision, lte: snapshotRevision } };
    const [internal, external] = await Promise.all([
      transaction.sighting.findMany({
        include: nestedRelations,
        orderBy: { publicFeedRevision: 'asc' },
        take,
        where,
      }),
      transaction.externalSighting.findMany({
        orderBy: { publicFeedRevision: 'asc' },
        take,
        where,
      }),
    ]);
    return [
      ...internal.map((row) => Object.freeze({ entity: 'internal' as const, row })),
      ...external.map((row) => Object.freeze({ entity: 'external' as const, row })),
    ].sort(compareSync).slice(0, take);
  }

  const [internal, external] = await Promise.all([
    transaction.sighting.findMany({
      include: nestedRelations,
      orderBy: [{ observedAt: 'desc' }, { publicFeedRevision: 'desc' }],
      take,
      where: historyWhere(snapshotRevision, read.cursor, true) as Prisma.SightingWhereInput,
    }),
    transaction.externalSighting.findMany({
      orderBy: [{ observedAt: 'desc' }, { publicFeedRevision: 'desc' }],
      take,
      where: historyWhere(snapshotRevision, read.cursor, false) as Prisma.ExternalSightingWhereInput,
    }),
  ]);
  return [
    ...internal.map((row) => Object.freeze({ entity: 'internal' as const, row })),
    ...external.map((row) => Object.freeze({ entity: 'external' as const, row })),
  ].sort(compareHistory).slice(0, take);
}

const sightingFeedRoutes: FastifyPluginAsync<BoundedReadRouteOptions> = async (app, options) => {
  app.get('/sighting-feed', async (request, reply) => {
    const read = resolveRead(request.query);
    const result = await boundedDatabaseRead(
      prisma,
      async (transaction) => {
        const currentHighWater = await highWater(transaction);
        const snapshotRevision = read.kind === 'history' && read.cursor
          ? read.cursor.snapshotRevision
          : currentHighWater;
        const [rows, providers] = await Promise.all([
          readRows(transaction, read, snapshotRevision),
          providerFreshness(transaction),
        ]);
        return Object.freeze({ providers, rows, snapshotRevision });
      },
      request.signal,
      options.statementTimeoutMs,
    );
    const hasMore = result.rows.length > read.limit;
    const visibleRows = result.rows.slice(0, read.limit);
    const last = visibleRows.at(-1);
    const syncRevision = read.kind === 'sync' && last
      ? rowRevision(last)
      : read.kind === 'sync'
        ? read.cursorRevision
        : result.snapshotRevision;
    const pageCursor = read.kind === 'history' && hasMore && last
      ? encodeFeedPageCursor({
          observedAt: rowObservedAt(last).toISOString(),
          revision: rowRevision(last),
          snapshotRevision: result.snapshotRevision,
        })
      : null;
    return sendPublicResponse(request, reply, SightingFeedPageSchema, {
      hasMore,
      items: visibleRows.map(toItem),
      pageCursor,
      providers: result.providers,
      syncCursor: encodeFeedSyncCursor(syncRevision),
    }, LIVE_READ_CACHE_POLICY);
  });
};

export default sightingFeedRoutes;
