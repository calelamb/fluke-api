import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  type IdConfidence,
  type SightingDTO,
} from '../contracts/index.js';
import { prisma } from '../db.js';

const sightingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/sightings', async (): Promise<SightingDTO[]> => {
    const sightings = await prisma.sighting.findMany({
      where: { status: 'APPROVED' },
      take: 100,
      orderBy: { observedAt: 'desc' },
      include: {
        photos: true,
        whales: {
          include: { whale: true },
        },
      },
    });

    return sightings.map((sighting) => {
      const orderedPhotos = [...sighting.photos].sort((a, b) => a.orderIndex - b.orderIndex);
      return {
        id: sighting.id,
        observedAt: sighting.observedAt.toISOString(),
        latitude: Number(sighting.latitude),
        longitude: Number(sighting.longitude),
        locationName: sighting.locationName,
        ecotypeGuess: sighting.ecotypeGuess,
        groupSize: sighting.groupSize,
        behaviorNotes: sighting.behaviorNotes,
        status: sighting.status,
        photoUrls: orderedPhotos.map((photo) => photo.url),
        photos: orderedPhotos.map((photo) => ({
          id: photo.id,
          url: photo.url,
          thumbnailUrl: photo.thumbnailUrl,
          orderIndex: photo.orderIndex,
        })),
        identifiedWhales: sighting.whales.map((sightingWhale) => ({
          catalogId: sightingWhale.whale.catalogId,
          name: sightingWhale.whale.name,
          confidence: sightingWhale.confidence as IdConfidence,
        })),
      };
    });
  });

  fastify.get('/sightings/historical', async (request, reply) => {
    const q = request.query as {
      from?: string;
      to?: string;
      pod?: string;
      whaleId?: string;
    };

    const where: Prisma.SightingWhereInput = { status: 'APPROVED' };
    const externalWhere: Prisma.ExternalSightingWhereInput = {};

    if (q.from || q.to) {
      where.observedAt = {};
      externalWhere.observedAt = {};
      if (q.from) {
        const d = new Date(q.from);
        if (isNaN(d.getTime())) {
          return reply.code(400).send({ error: 'Invalid from date' });
        }
        where.observedAt.gte = d;
        externalWhere.observedAt.gte = d;
      }
      if (q.to) {
        const d = new Date(q.to);
        if (isNaN(d.getTime())) {
          return reply.code(400).send({ error: 'Invalid to date' });
        }
        where.observedAt.lte = d;
        externalWhere.observedAt.lte = d;
      }
    }

    if (q.pod) {
      where.whales = { some: { whale: { pod: q.pod } } };
    }
    if (q.whaleId) {
      where.whales = { some: { whaleId: q.whaleId } };
    }

    const userSightings = await prisma.sighting.findMany({
      where,
      orderBy: { observedAt: 'asc' },
      select: {
        id: true,
        observedAt: true,
        latitude: true,
        longitude: true,
        locationName: true,
        ecotypeGuess: true,
        whales: { select: { whaleId: true } },
      },
    });

    // External sightings (Acartia, GBIF, etc.) are filtered by ecotype when a
    // pod is requested (resident pods → RESIDENT ecotype; Bigg's → BIGGS).
    // They have no whale-link join, so whaleId queries skip them entirely.
    const externalEcotype = q.pod === 'BIGGS'
      ? 'BIGGS'
      : q.pod === 'J' || q.pod === 'K' || q.pod === 'L'
        ? 'RESIDENT'
        : undefined;
    const filteredExternalWhere: Prisma.ExternalSightingWhereInput = {
      ...externalWhere,
      ...(externalEcotype ? { ecotypeGuess: externalEcotype } : {}),
    };
    const externalSightings = q.whaleId
      ? []
      : await prisma.externalSighting.findMany({
          where: filteredExternalWhere,
          orderBy: { observedAt: 'asc' },
          select: {
            id: true,
            observedAt: true,
            latitude: true,
            longitude: true,
            ecotypeGuess: true,
          },
        });

    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

    const userMapped = userSightings.map((s) => ({
      id: s.id,
      observedAt: s.observedAt.toISOString(),
      latitude: Number(s.latitude),
      longitude: Number(s.longitude),
      locationName: s.locationName,
      ecotypeGuess: s.ecotypeGuess,
      whaleIds: s.whales.map((w) => w.whaleId),
    }));

    const externalMapped = externalSightings.map((s) => ({
      id: `ext:${s.id}`,
      observedAt: s.observedAt.toISOString(),
      latitude: Number(s.latitude),
      longitude: Number(s.longitude),
      locationName: null,
      ecotypeGuess: s.ecotypeGuess,
      whaleIds: [] as string[],
    }));

    const merged = [...userMapped, ...externalMapped];
    merged.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    return merged;
  });
};

export default sightingsRoutes;
