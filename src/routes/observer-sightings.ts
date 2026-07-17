import type { FastifyPluginAsync } from 'fastify';
import { MySightingPageSchema, SightingsQuerySchema, type MySighting } from '../contracts/index.js';
import { prisma } from '../db.js';
import { decodeCursor, encodeCursor, SightingCursorSchema } from '../lib/cursor.js';
import { requireObserver } from '../lib/observer-auth.js';

function toDto(row: {
  readonly _count: { readonly photos: number };
  readonly behaviorNotes: string | null;
  readonly createdAt: Date;
  readonly ecotypeGuess: string | null;
  readonly groupSize: number | null;
  readonly id: string;
  readonly latitude: unknown;
  readonly locationName: string | null;
  readonly longitude: unknown;
  readonly observedAt: Date;
  readonly rejectionReason: string | null;
  readonly status: string;
}): MySighting {
  return MySightingPageSchema.shape.items.element.parse({
    behaviorNotes: row.behaviorNotes,
    createdAt: row.createdAt.toISOString(),
    ecotypeGuess: row.ecotypeGuess,
    groupSize: row.groupSize,
    id: row.id,
    latitude: Number(row.latitude),
    locationName: row.locationName,
    longitude: Number(row.longitude),
    observedAt: row.observedAt.toISOString(),
    photoCount: row._count.photos,
    rejectionReason: row.rejectionReason,
    status: row.status,
  });
}

const observerSightingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/sightings/me', { preHandler: requireObserver }, async (request, reply) => {
    const query = SightingsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid pagination request' });
    const observer = request.observer;
    if (observer === undefined) return reply.code(401).send({ error: 'Authentication required' });
    const cursor = query.data.cursor
      ? decodeCursor(query.data.cursor, SightingCursorSchema)
      : null;
    const cursorWhere = cursor === null ? {} : {
      OR: [
        { observedAt: { lt: new Date(cursor.observedAt) } },
        { observedAt: new Date(cursor.observedAt), id: { lt: cursor.id } },
      ],
    };
    const rows = await prisma.sighting.findMany({
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      select: {
        _count: { select: { photos: true } },
        behaviorNotes: true, createdAt: true, ecotypeGuess: true, groupSize: true,
        id: true, latitude: true, locationName: true, longitude: true,
        observedAt: true, rejectionReason: true, status: true,
      },
      take: query.data.limit + 1,
      where: cursor === null
        ? { observerUserId: observer.id }
        : { AND: [{ observerUserId: observer.id }, cursorWhere] },
    });
    const hasMore = rows.length > query.data.limit;
    const pageRows = rows.slice(0, query.data.limit);
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last
      ? encodeCursor({
        id: last.id, kind: 'sightings', observedAt: last.observedAt.toISOString(), version: 1,
      })
      : null;
    return MySightingPageSchema.parse({
      items: pageRows.map(toDto), page: { hasMore, nextCursor },
    });
  });
};

export default observerSightingsRoutes;
