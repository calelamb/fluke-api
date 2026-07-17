import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  HistoricalSightingPageSchema,
  HistoricalSightingsQuerySchema,
  type HistoricalSighting,
  type Pod,
} from '../contracts/index.js';
import { prisma } from '../db.js';
import {
  decodeCursor,
  encodeCursor,
  HistoricalSightingCursorSchema,
  type HistoricalSightingCursor,
  InvalidCursorError,
} from '../lib/cursor.js';
import {
  CATALOG_CACHE_POLICY,
  sendPublicResponse,
} from '../lib/public-response.js';
import { abortableRead } from '../lib/read-deadline.js';

const DEFAULT_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;
const TRANSACTION_MAX_WAIT_MS = 1_000;
const TRANSACTION_TIMEOUT_MS = 4_000;

interface HistoricalCandidate {
  readonly dto: HistoricalSighting;
  readonly id: string;
  readonly observedAt: Date;
  readonly source: HistoricalSightingCursor['source'];
}

interface HistoricalRead {
  readonly cursor: HistoricalSightingCursor | null;
  readonly from: string;
  readonly limit: number;
  readonly pod: Pod | null;
  readonly to: string;
}

interface InternalRow {
  readonly ecotypeGuess: HistoricalSighting['ecotypeGuess'];
  readonly id: string;
  readonly latitude: unknown;
  readonly locationName: string | null;
  readonly longitude: unknown;
  readonly observedAt: Date;
  readonly whales: readonly { readonly whaleId: string }[];
}

interface ExternalRow {
  readonly ecotypeGuess: HistoricalSighting['ecotypeGuess'];
  readonly id: string;
  readonly latitude: unknown;
  readonly longitude: unknown;
  readonly observedAt: Date;
}

function hasOwnQueryValue(query: unknown, key: string): boolean {
  return typeof query === 'object'
    && query !== null
    && Object.prototype.hasOwnProperty.call(query, key);
}

function resolveRead(input: unknown): HistoricalRead {
  const query = HistoricalSightingsQuerySchema.safeParse(input);
  if (!query.success) throw new InvalidCursorError();
  const cursor = query.data.cursor
    ? decodeCursor(query.data.cursor, HistoricalSightingCursorSchema)
    : null;
  const mismatched = cursor && (
    (hasOwnQueryValue(input, 'from') && query.data.from !== cursor.from)
    || (hasOwnQueryValue(input, 'to') && query.data.to !== cursor.to)
    || (hasOwnQueryValue(input, 'pod') && query.data.pod !== cursor.pod)
  );
  if (mismatched) throw new InvalidCursorError();

  const defaultTo = new Date();
  return {
    cursor,
    from: cursor?.from
      ?? query.data.from
      ?? new Date(defaultTo.getTime() - DEFAULT_WINDOW_MS).toISOString(),
    limit: query.data.limit,
    pod: cursor?.pod ?? query.data.pod ?? null,
    to: cursor?.to ?? query.data.to ?? defaultTo.toISOString(),
  };
}

function internalCursorBoundary(cursor: HistoricalSightingCursor | null): Prisma.SightingWhereInput | null {
  if (!cursor) return null;
  if (cursor.source === 'external') {
    return { observedAt: { gt: new Date(cursor.observedAt) } };
  }
  return {
    OR: [
      { observedAt: { gt: new Date(cursor.observedAt) } },
      { observedAt: new Date(cursor.observedAt), id: { gt: cursor.id } },
    ],
  };
}

function externalCursorBoundary(
  cursor: HistoricalSightingCursor | null,
): Prisma.ExternalSightingWhereInput | null {
  if (!cursor) return null;
  if (cursor.source === 'internal') {
    return { observedAt: { gte: new Date(cursor.observedAt) } };
  }
  return {
    OR: [
      { observedAt: { gt: new Date(cursor.observedAt) } },
      { observedAt: new Date(cursor.observedAt), id: { gt: cursor.id } },
    ],
  };
}

function externalEcotype(pod: Pod | null): 'BIGGS' | 'RESIDENT' | undefined {
  if (pod === 'BIGGS') return 'BIGGS';
  if (pod === 'J' || pod === 'K' || pod === 'L') return 'RESIDENT';
  return undefined;
}

function toInternalCandidate(row: InternalRow): HistoricalCandidate {
  return {
    dto: {
      ecotypeGuess: row.ecotypeGuess,
      id: row.id,
      latitude: Number(row.latitude),
      locationName: row.locationName,
      longitude: Number(row.longitude),
      observedAt: row.observedAt.toISOString(),
      whaleIds: row.whales.map((whale) => whale.whaleId),
    },
    id: row.id,
    observedAt: row.observedAt,
    source: 'internal',
  };
}

function toExternalCandidate(row: ExternalRow): HistoricalCandidate {
  return {
    dto: {
      ecotypeGuess: row.ecotypeGuess,
      id: `ext:${row.id}`,
      latitude: Number(row.latitude),
      locationName: null,
      longitude: Number(row.longitude),
      observedAt: row.observedAt.toISOString(),
      whaleIds: [],
    },
    id: row.id,
    observedAt: row.observedAt,
    source: 'external',
  };
}

function historicalWhere(read: HistoricalRead) {
  const dateRange = { gte: new Date(read.from), lte: new Date(read.to) };
  const internalBase: Prisma.SightingWhereInput = {
    observedAt: dateRange,
    status: 'APPROVED',
    ...(read.pod ? { whales: { some: { whale: { pod: read.pod } } } } : {}),
  };
  const ecotype = externalEcotype(read.pod);
  const externalBase: Prisma.ExternalSightingWhereInput = {
    observedAt: dateRange,
    ...(ecotype ? { ecotypeGuess: ecotype } : {}),
  };
  const internalBoundary = internalCursorBoundary(read.cursor);
  const externalBoundary = externalCursorBoundary(read.cursor);
  return {
    external: externalBoundary ? { AND: [externalBase, externalBoundary] } : externalBase,
    internal: internalBoundary ? { AND: [internalBase, internalBoundary] } : internalBase,
  };
}

async function fetchCandidates(read: HistoricalRead, signal: AbortSignal) {
  const where = historicalWhere(read);
  const take = read.limit + 1;
  const operation = prisma.$transaction(async (transaction) => Promise.all([
    transaction.sighting.findMany({
      where: where.internal,
      orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
      take,
      select: {
        ecotypeGuess: true, id: true, latitude: true, locationName: true,
        longitude: true, observedAt: true, whales: { select: { whaleId: true } },
      },
    }),
    transaction.externalSighting.findMany({
      where: where.external,
      orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
      take,
      select: {
        ecotypeGuess: true, id: true, latitude: true, longitude: true, observedAt: true,
      },
    }),
  ]), {
    maxWait: TRANSACTION_MAX_WAIT_MS,
    timeout: TRANSACTION_TIMEOUT_MS,
  });
  const [internalRows, externalRows] = await abortableRead(operation, signal);
  return [
    ...internalRows.map(toInternalCandidate),
    ...externalRows.map(toExternalCandidate),
  ];
}

function compareCandidates(left: HistoricalCandidate, right: HistoricalCandidate): number {
  const timeDifference = left.observedAt.getTime() - right.observedAt.getTime();
  if (timeDifference !== 0) return timeDifference;
  if (left.source !== right.source) return left.source === 'internal' ? -1 : 1;
  return left.id.localeCompare(right.id);
}

function historicalPage(candidates: readonly HistoricalCandidate[], read: HistoricalRead) {
  const ordered = [...candidates].sort(compareCandidates);
  const items = ordered.slice(0, read.limit);
  const last = items.at(-1);
  const hasMore = ordered.length > read.limit;
  return {
    items: items.map((candidate) => candidate.dto),
    page: hasMore && last
      ? {
          hasMore: true as const,
          nextCursor: encodeCursor({
            from: read.from,
            id: last.id,
            kind: 'historical-sightings',
            observedAt: last.observedAt.toISOString(),
            pod: read.pod,
            source: last.source,
            to: read.to,
            version: 1,
          }),
        }
      : { hasMore: false as const, nextCursor: null },
  };
}

async function handleHistoricalSightings(request: FastifyRequest, reply: FastifyReply) {
  const read = resolveRead(request.query);
  const candidates = await fetchCandidates(read, request.signal);
  return sendPublicResponse(
    request,
    reply,
    HistoricalSightingPageSchema,
    historicalPage(candidates, read),
    CATALOG_CACHE_POLICY,
  );
}

const historicalSightingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/sightings/historical', handleHistoricalSightings);
};

export default historicalSightingsRoutes;
