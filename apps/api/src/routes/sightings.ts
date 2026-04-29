import type { IdConfidence, SightingDTO } from '@fluke/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const notImplemented = {
  error: 'Not implemented; reserved for future user-account work',
};

const SubmitSightingBody = z.object({
  observedAt: z.string().datetime(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  locationName: z.string().max(200).optional().nullable(),
  ecotypeGuess: z.enum(['RESIDENT', 'BIGGS', 'OFFSHORE', 'UNKNOWN']).optional().nullable(),
  groupSize: z.number().int().min(1).max(100).optional().nullable(),
  behaviorNotes: z.string().max(2000).optional().nullable(),
  observerName: z.string().max(120).optional().nullable(),
  observerEmail: z.string().email().max(200),
});

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

  fastify.post(
    '/sightings',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const parsed = SubmitSightingBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid sighting submission' });
      }

      const body = parsed.data;
      const sighting = await prisma.sighting.create({
        data: {
          observedAt: new Date(body.observedAt),
          latitude: body.latitude,
          longitude: body.longitude,
          locationName: body.locationName,
          ecotypeGuess: body.ecotypeGuess,
          groupSize: body.groupSize,
          behaviorNotes: body.behaviorNotes,
          observerName: body.observerName,
          observerEmail: body.observerEmail,
          status: 'PENDING',
        },
      });

      return reply.code(201).send({ ok: true, id: sighting.id });
    },
  );
  fastify.put('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
  fastify.patch('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
  fastify.delete('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
};

export default sightingsRoutes;
