import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PodSchema, PredictionSchema } from '../contracts/index.js';
import { prisma } from '../db.js';
import {
  boundedDatabaseRead,
  type BoundedReadRouteOptions,
} from '../lib/bounded-database-read.js';
import {
  LIVE_READ_CACHE_POLICY,
  sendPublicResponse,
} from '../lib/public-response.js';

const HORIZON_TO_HOURS = Object.freeze({
  '24h': 24,
  '7d': 168,
  '30d': 720,
});

const PredictionQuerySchema = z.object({
  horizon: z.enum(['24h', '7d', '30d']).default('24h'),
  pod: PodSchema.optional(),
  whaleId: z.string().min(1).max(200).optional(),
}).strict().refine((value) => Boolean(value.whaleId) !== Boolean(value.pod), {
  message: 'exactly one of whaleId or pod is required',
});

const predictRoutes: FastifyPluginAsync<BoundedReadRouteOptions> = async (fastify, options) => {
  fastify.get('/predict', async (request, reply) => {
    const query = PredictionQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'Invalid query parameters' });
    }

    const subjectKind = query.data.whaleId ? 'WHALE' : 'POD';
    const subjectId = query.data.whaleId ?? query.data.pod;
    if (!subjectId) {
      return reply.code(400).send({ error: 'Invalid query parameters' });
    }
    const grid = await boundedDatabaseRead(prisma, (transaction) =>
      transaction.predictionGrid.findUnique({
      where: {
        subjectKind_subjectId_horizonHours: {
          horizonHours: HORIZON_TO_HOURS[query.data.horizon],
          subjectId,
          subjectKind,
        },
      },
    }), request.signal, options.statementTimeoutMs);

    if (!grid) {
      return reply.code(404).send({ error: 'No prediction available' });
    }
    const payload = {
      cells: grid.cells,
      computedAt: grid.computedAt.toISOString(),
      confidence: Number(grid.confidence),
      modelVersion: grid.modelVersion,
    };

    return sendPublicResponse(
      request,
      reply,
      PredictionSchema,
      payload,
      LIVE_READ_CACHE_POLICY,
    );
  });
};

export default predictRoutes;
