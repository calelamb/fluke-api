import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  IsoDateTimeSchema,
  type NotableEvent,
  type SourceCitation,
  type WhaleDTO,
  WhalePageSchema,
  WhaleProfileSchema,
  type WhaleProfileDTO,
  WhaleTrackSchema,
  WhalesQuerySchema,
} from '../contracts/index.js';
import { prisma } from '../db.js';
import {
  decodeCursor,
  encodeCursor,
  WhaleCursorSchema,
} from '../lib/cursor.js';
import {
  CATALOG_CACHE_POLICY,
  LIVE_READ_CACHE_POLICY,
  sendPublicResponse,
} from '../lib/public-response.js';
import { abortableRead } from '../lib/read-deadline.js';

const MAX_TRACK_POINTS = 1_000;
const MAX_TRACK_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;

const WhaleTrackQuerySchema = z.object({
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'from must not exceed to',
      path: ['from'],
    });
  }
  if (value.from && value.to && Date.parse(value.to) - Date.parse(value.from) > MAX_TRACK_WINDOW_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'date window is too large',
      path: ['to'],
    });
  }
});

function asNotableEvents(value: unknown): NotableEvent[] {
  return Array.isArray(value) ? (value as NotableEvent[]) : [];
}

function asSourceCitations(value: unknown): SourceCitation[] {
  return Array.isArray(value) ? (value as SourceCitation[]) : [];
}

function toWhaleDTO(whale: {
  id: string;
  catalogId: string;
  name: string | null;
  ecotype: WhaleDTO['ecotype'];
  pod: string | null;
  sex: WhaleDTO['sex'];
  birthYear: number | null;
  deathYear: number | null;
  status: WhaleDTO['status'];
  biography: string | null;
  distinguishingMarks: string | null;
  heroImageUrl: string | null;
  notableEvents: unknown;
  sourceCitations: unknown;
}): WhaleDTO {
  return {
    id: whale.id,
    catalogId: whale.catalogId,
    name: whale.name,
    ecotype: whale.ecotype,
    pod: whale.pod,
    sex: whale.sex,
    birthYear: whale.birthYear,
    deathYear: whale.deathYear,
    status: whale.status,
    biography: whale.biography,
    distinguishingMarks: whale.distinguishingMarks,
    heroImageUrl: whale.heroImageUrl,
    notableEvents: asNotableEvents(whale.notableEvents).slice().sort((a, b) => a.year - b.year),
    sourceCitations: asSourceCitations(whale.sourceCitations),
  };
}

function whaleBoundary(
  cursor: z.infer<typeof WhaleCursorSchema> | null,
): Prisma.WhaleWhereInput {
  if (!cursor) return {};
  return {
    OR: [
      { catalogId: { gt: cursor.catalogId } },
      { catalogId: cursor.catalogId, id: { gt: cursor.id } },
    ],
  };
}

async function handleWhaleList(request: FastifyRequest, reply: FastifyReply) {
  const query = WhalesQuerySchema.safeParse(request.query);
  if (!query.success) {
    return reply.code(400).send({ error: 'Invalid query parameters' });
  }
  const cursor = query.data.cursor
    ? decodeCursor(query.data.cursor, WhaleCursorSchema)
    : null;
  const rows = await abortableRead(prisma.whale.findMany({
    where: whaleBoundary(cursor),
    take: query.data.limit + 1,
    orderBy: [{ catalogId: 'asc' }, { id: 'asc' }],
  }), request.signal);
  const whales = rows.slice(0, query.data.limit);
  const last = whales.at(-1);
  const payload = {
    items: whales.map(toWhaleDTO),
    page: rows.length > query.data.limit && last
      ? {
          hasMore: true as const,
          nextCursor: encodeCursor({
            catalogId: last.catalogId,
            id: last.id,
            kind: 'whales',
            version: 1,
          }),
        }
      : { hasMore: false as const, nextCursor: null },
  };
  return sendPublicResponse(request, reply, WhalePageSchema, payload, CATALOG_CACHE_POLICY);
}

function findWhaleProfile(id: string) {
  return prisma.whale.findUnique({
    where: { id },
    include: {
      mother: { select: { catalogId: true, name: true } },
      offspring: { select: { catalogId: true, name: true } },
      sightings: {
        where: { sighting: { status: 'APPROVED' as const } },
        take: 25,
        orderBy: [
          { sighting: { observedAt: 'desc' as const } },
          { sighting: { id: 'desc' as const } },
        ],
        include: {
          sighting: {
            select: {
              id: true,
              observedAt: true,
              locationName: true,
              latitude: true,
              longitude: true,
            },
          },
        },
      },
    },
  });
}

type WhaleRequest = FastifyRequest<{ Params: { id: string } }>;

async function handleWhaleProfile(request: WhaleRequest, reply: FastifyReply) {
  const whale = await abortableRead(findWhaleProfile(request.params.id), request.signal);
  if (!whale) return reply.code(404).send({ error: 'Whale not found' });

  const dto: WhaleProfileDTO = {
    ...toWhaleDTO(whale),
    mother: whale.mother,
    offspring: whale.offspring,
    recentSightings: whale.sightings.map(({ sighting }) => ({
      id: sighting.id,
      observedAt: sighting.observedAt.toISOString(),
      locationName: sighting.locationName,
      latitude: Number(sighting.latitude),
      longitude: Number(sighting.longitude),
    })),
  };
  return sendPublicResponse(request, reply, WhaleProfileSchema, dto, CATALOG_CACHE_POLICY);
}

function findTrackPoints(
  whaleId: string,
  query: z.infer<typeof WhaleTrackQuerySchema>,
) {
  const observedAt = {
    ...(query.from ? { gte: new Date(query.from) } : {}),
    ...(query.to ? { lte: new Date(query.to) } : {}),
  };
  return prisma.sighting.findMany({
    where: {
      status: 'APPROVED',
      whales: { some: { whaleId } },
      ...(Object.keys(observedAt).length > 0 ? { observedAt } : {}),
    },
    orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
    take: MAX_TRACK_POINTS,
    select: {
      behaviorNotes: true,
      id: true,
      latitude: true,
      locationName: true,
      longitude: true,
      observedAt: true,
    },
  });
}

async function handleWhaleTrack(request: WhaleRequest, reply: FastifyReply) {
  const query = WhaleTrackQuerySchema.safeParse(request.query);
  if (!query.success) {
    return reply.code(400).send({ error: 'Invalid query parameters' });
  }
  const whale = await abortableRead(prisma.whale.findUnique({
    where: { id: request.params.id },
    select: { catalogId: true, id: true },
  }), request.signal);
  if (!whale) return reply.code(404).send({ error: 'Whale not found' });

  const points = await abortableRead(findTrackPoints(whale.id, query.data), request.signal);
  const payload = {
    catalogId: whale.catalogId,
    points: points.map((point) => ({
      behaviorNotes: point.behaviorNotes,
      id: point.id,
      latitude: Number(point.latitude),
      locationName: point.locationName,
      longitude: Number(point.longitude),
      observedAt: point.observedAt.toISOString(),
    })),
    whaleId: whale.id,
  };
  return sendPublicResponse(request, reply, WhaleTrackSchema, payload, LIVE_READ_CACHE_POLICY);
}

const whalesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/whales', handleWhaleList);
  fastify.get<{ Params: { id: string } }>('/whales/:id', handleWhaleProfile);
  fastify.get<{ Params: { id: string } }>('/whales/:id/track', handleWhaleTrack);
};

export default whalesRoutes;
