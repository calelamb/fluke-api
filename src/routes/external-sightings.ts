import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  type Ecotype,
  ExternalSightingPageSchema,
  ExternalSightingsQuerySchema,
} from '../contracts/index.js';
import { prisma } from '../db.js';
import {
  boundedDatabaseRead,
  type BoundedReadRouteOptions,
} from '../lib/bounded-database-read.js';
import {
  decodeCursor,
  encodeCursor,
  ExternalSightingCursorSchema,
  type ExternalSightingCursor,
  InvalidCursorError,
} from '../lib/cursor.js';
import {
  LIVE_READ_CACHE_POLICY,
  sendPublicResponse,
} from '../lib/public-response.js';

type ExternalRow = Prisma.ExternalSightingGetPayload<Record<string, never>>;

interface ExternalRead {
  readonly cursor: ExternalSightingCursor | null;
  readonly limit: number;
  readonly since: Date;
  readonly sinceDays: number;
  readonly source: string | null;
}

function hasOwnQueryValue(query: unknown, key: string): boolean {
  return typeof query === 'object'
    && query !== null
    && Object.prototype.hasOwnProperty.call(query, key);
}

function cursorWindowIsValid(since: string, sinceDays: number): boolean {
  const ageMs = Date.now() - Date.parse(since);
  const toleranceMs = 24 * 60 * 60 * 1_000;
  return ageMs >= -toleranceMs
    && ageMs <= sinceDays * 24 * 60 * 60 * 1_000 + toleranceMs;
}

function resolveRead(input: unknown): ExternalRead {
  const query = ExternalSightingsQuerySchema.safeParse(input);
  if (!query.success) throw new InvalidCursorError();
  const cursor = query.data.cursor
    ? decodeCursor(query.data.cursor, ExternalSightingCursorSchema)
    : null;
  const mismatched = cursor && (
    !cursorWindowIsValid(cursor.since, cursor.sinceDays)
    || (hasOwnQueryValue(input, 'source') && query.data.source !== cursor.source)
    || (hasOwnQueryValue(input, 'sinceDays') && query.data.sinceDays !== cursor.sinceDays)
  );
  if (mismatched) throw new InvalidCursorError();

  const source = cursor?.source ?? query.data.source ?? null;
  const sinceDays = cursor?.sinceDays ?? query.data.sinceDays;
  return {
    cursor,
    limit: query.data.limit,
    since: cursor
      ? new Date(cursor.since)
      : new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1_000),
    sinceDays,
    source,
  };
}

function externalWhere(read: ExternalRead): Prisma.ExternalSightingWhereInput {
  const base: Prisma.ExternalSightingWhereInput = {
    ...(read.source ? { source: read.source } : {}),
    observedAt: { gte: read.since },
  };
  if (!read.cursor) return base;
  const observedAt = new Date(read.cursor.observedAt);
  return {
    AND: [base, {
      OR: [
        { observedAt: { lt: observedAt } },
        { observedAt, id: { lt: read.cursor.id } },
      ],
    }],
  };
}

function toExternalDTO(row: ExternalRow) {
  return {
    attribution: row.attribution,
    ecotypeGuess: row.ecotypeGuess as Ecotype | null,
    externalId: row.externalId,
    groupSize: row.groupSize,
    id: row.id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    notes: row.notes,
    observedAt: row.observedAt.toISOString(),
    source: row.source,
    sourceUrl: row.sourceUrl,
    species: row.species,
    trusted: row.trusted,
  };
}

function externalPage(rows: readonly ExternalRow[], read: ExternalRead) {
  const items = rows.slice(0, read.limit);
  const last = items.at(-1);
  const hasMore = rows.length > read.limit;
  return {
    items: items.map(toExternalDTO),
    page: hasMore && last
      ? {
          hasMore: true as const,
          nextCursor: encodeCursor({
            id: last.id,
            kind: 'external-sightings',
            observedAt: last.observedAt.toISOString(),
            since: read.since.toISOString(),
            sinceDays: read.sinceDays,
            source: read.source,
            version: 1,
          }),
        }
      : { hasMore: false as const, nextCursor: null },
  };
}

async function handleExternalSightings(
  request: FastifyRequest,
  reply: FastifyReply,
  statementTimeoutMs: number,
) {
  const read = resolveRead(request.query);
  const rows = await boundedDatabaseRead(prisma, (transaction) =>
    transaction.externalSighting.findMany({
      where: externalWhere(read),
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: read.limit + 1,
    }), request.signal, statementTimeoutMs);
  return sendPublicResponse(
    request,
    reply,
    ExternalSightingPageSchema,
    externalPage(rows, read),
    LIVE_READ_CACHE_POLICY,
  );
}

const externalSightingsRoutes: FastifyPluginAsync<BoundedReadRouteOptions> = async (
  fastify,
  options,
) => {
  fastify.get('/external-sightings', (request, reply) =>
    handleExternalSightings(request, reply, options.statementTimeoutMs));
};

export default externalSightingsRoutes;
