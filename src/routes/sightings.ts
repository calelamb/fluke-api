import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type IdConfidence,
  type SightingDTO,
  SightingPageSchema,
  SightingsQuerySchema,
} from '../contracts/index.js';
import { prisma } from '../db.js';
import {
  decodeCursor,
  encodeCursor,
  SightingCursorSchema,
} from '../lib/cursor.js';
import {
  LIVE_READ_CACHE_POLICY,
  sendPublicResponse,
} from '../lib/public-response.js';
import { abortableRead } from '../lib/read-deadline.js';

function toSightingDTO(sighting: {
  id: string;
  observedAt: Date;
  latitude: unknown;
  longitude: unknown;
  locationName: string | null;
  ecotypeGuess: SightingDTO['ecotypeGuess'];
  groupSize: number | null;
  behaviorNotes: string | null;
  status: SightingDTO['status'];
  photos: Array<{
    id: string;
    url: string;
    thumbnailUrl: string;
    orderIndex: number;
  }>;
  whales: Array<{
    confidence: IdConfidence;
    whale: { catalogId: string; name: string | null };
  }>;
}): SightingDTO {
  const orderedPhotos = [...sighting.photos].sort((left, right) =>
    left.orderIndex - right.orderIndex);
  return {
    behaviorNotes: sighting.behaviorNotes,
    ecotypeGuess: sighting.ecotypeGuess,
    groupSize: sighting.groupSize,
    id: sighting.id,
    identifiedWhales: sighting.whales.map((sightingWhale) => ({
      catalogId: sightingWhale.whale.catalogId,
      confidence: sightingWhale.confidence,
      name: sightingWhale.whale.name,
    })),
    latitude: Number(sighting.latitude),
    locationName: sighting.locationName,
    longitude: Number(sighting.longitude),
    observedAt: sighting.observedAt.toISOString(),
    photoUrls: orderedPhotos.map((photo) => photo.url),
    photos: orderedPhotos.map((photo) => ({
      id: photo.id,
      orderIndex: photo.orderIndex,
      thumbnailUrl: photo.thumbnailUrl,
      url: photo.url,
    })),
    status: sighting.status,
  };
}

function sightingBoundary(
  cursor: z.infer<typeof SightingCursorSchema> | null,
): Prisma.SightingWhereInput {
  const approved: Prisma.SightingWhereInput = { status: 'APPROVED' };
  if (!cursor) return approved;

  return {
    AND: [approved, {
      OR: [
        { observedAt: { lt: new Date(cursor.observedAt) } },
        { observedAt: new Date(cursor.observedAt), id: { lt: cursor.id } },
      ],
    }],
  };
}

async function handleSightings(request: FastifyRequest, reply: FastifyReply) {
  const query = SightingsQuerySchema.safeParse(request.query);
  if (!query.success) {
    return reply.code(400).send({ error: 'Invalid query parameters' });
  }
  const cursor = query.data.cursor
    ? decodeCursor(query.data.cursor, SightingCursorSchema)
    : null;
  const rows = await abortableRead(prisma.sighting.findMany({
    where: sightingBoundary(cursor),
    take: query.data.limit + 1,
    orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    include: { photos: true, whales: { include: { whale: true } } },
  }), request.signal);
  const sightings = rows.slice(0, query.data.limit);
  const last = sightings.at(-1);
  const payload = {
    items: sightings.map(toSightingDTO),
    page: rows.length > query.data.limit && last
      ? {
          hasMore: true as const,
          nextCursor: encodeCursor({
            id: last.id,
            kind: 'sightings',
            observedAt: last.observedAt.toISOString(),
            version: 1,
          }),
        }
      : { hasMore: false as const, nextCursor: null },
  };
  return sendPublicResponse(request, reply, SightingPageSchema, payload, LIVE_READ_CACHE_POLICY);
}

const sightingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/sightings', handleSightings);
};

export default sightingsRoutes;
