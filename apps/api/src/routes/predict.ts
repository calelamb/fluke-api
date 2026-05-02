import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';

const HORIZON_TO_HOURS: Record<string, number> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
};

const predictRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/predict', async (request, reply) => {
    const q = request.query as {
      whaleId?: string;
      pod?: string;
      horizon?: string;
    };
    const horizon = q.horizon ?? '24h';
    const horizonHours = HORIZON_TO_HOURS[horizon];
    if (!horizonHours) {
      return reply.code(400).send({ error: 'horizon must be 24h, 7d, or 30d' });
    }

    const subjectKind = q.whaleId ? 'WHALE' : q.pod ? 'POD' : null;
    const subjectId = q.whaleId ?? q.pod;
    if (!subjectKind || !subjectId) {
      return reply.code(400).send({ error: 'whaleId or pod required' });
    }

    const grid = await prisma.predictionGrid.findUnique({
      where: {
        subjectKind_subjectId_horizonHours: {
          subjectKind,
          subjectId,
          horizonHours,
        },
      },
    });

    if (!grid) {
      return reply.code(404).send({ error: 'No prediction available — too few historical sightings' });
    }

    return {
      cells: grid.cells,
      confidence: Number(grid.confidence),
      modelVersion: grid.modelVersion,
      computedAt: grid.computedAt.toISOString(),
    };
  });
};

export default predictRoutes;
