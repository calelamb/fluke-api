import type { FastifyPluginAsync } from 'fastify';

const identifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/identify', async (_request, reply) =>
    reply.code(501).send({ error: 'Not implemented; ML photo identification ships in Phase 2' }),
  );
};

export default identifyRoutes;
