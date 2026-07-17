import type { FastifyPluginAsync } from 'fastify';

export type ReadinessProbe = () => Promise<void>;

interface HealthRouteOptions {
  readonly readinessProbe: ReadinessProbe;
}

const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (fastify, options) => {
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  fastify.get('/ready', async (_request, reply) => {
    try {
      await options.readinessProbe();
      return { status: 'ready' };
    } catch (error) {
      fastify.log.warn({ err: error }, 'Readiness probe failed');
      return reply.code(503).send({ status: 'unready' });
    }
  });
};

export default healthRoutes;
