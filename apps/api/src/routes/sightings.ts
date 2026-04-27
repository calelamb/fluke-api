import type { IdConfidence, SightingDTO } from '@fluke/shared';
import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';

const notImplemented = {
  error: 'Not implemented in milestone 1',
};

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

    return sightings.map((sighting) => ({
      id: sighting.id,
      observedAt: sighting.observedAt.toISOString(),
      latitude: Number(sighting.latitude),
      longitude: Number(sighting.longitude),
      locationName: sighting.locationName,
      ecotypeGuess: sighting.ecotypeGuess,
      groupSize: sighting.groupSize,
      behaviorNotes: sighting.behaviorNotes,
      status: sighting.status,
      photoUrls: sighting.photos
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((photo) => photo.url),
      identifiedWhales: sighting.whales.map((sightingWhale) => ({
        catalogId: sightingWhale.whale.catalogId,
        name: sightingWhale.whale.name,
        confidence: sightingWhale.confidence as IdConfidence,
      })),
    }));
  });

  fastify.post('/sightings', async (_request, reply) => reply.code(501).send(notImplemented));
  fastify.put('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
  fastify.patch('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
  fastify.delete('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
};

export default sightingsRoutes;
