import type { FastifyPluginAsync } from 'fastify';
import { HealthSchema, ReadinessSchema } from '../contracts/index.js';

export type ReadinessProbe = () => Promise<void>;

interface HealthRouteOptions {
  readonly readinessProbe: ReadinessProbe;
}

const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (fastify, options) => {
  fastify.get('/health', async () => HealthSchema.parse({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  fastify.get('/ready', async (_request, reply) => {
    try {
      await options.readinessProbe();
      return ReadinessSchema.parse({ status: 'ready' });
    } catch (error) {
      fastify.log.warn({ err: error }, 'Readiness probe failed');
      return reply.code(503).send({ status: 'unready' });
    }
  });
};

export default healthRoutes;
