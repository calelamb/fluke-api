import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Ecotype, ExternalSightingDTO } from '../contracts/index.js';
import { prisma } from '../db.js';

const ListQuery = z.object({
  source: z.string().optional(),
  sinceDays: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const externalSightingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/external-sightings', async (request, reply): Promise<ExternalSightingDTO[] | void> => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters' });
    }

    const { source, sinceDays, limit } = parsed.data;
    const since = sinceDays
      ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await prisma.externalSighting.findMany({
      where: {
        ...(source ? { source } : {}),
        observedAt: { gte: since },
      },
      orderBy: { observedAt: 'desc' },
      take: limit ?? 200,
    });

    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      externalId: row.externalId,
      observedAt: row.observedAt.toISOString(),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      species: row.species,
      ecotypeGuess: row.ecotypeGuess as Ecotype | null,
      groupSize: row.groupSize,
      attribution: row.attribution,
      sourceUrl: row.sourceUrl,
      notes: row.notes,
      trusted: row.trusted,
    }));
  });
};

export default externalSightingsRoutes;
