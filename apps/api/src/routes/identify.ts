import type { FastifyPluginAsync } from 'fastify';

const identifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/identify', async (_request, reply) =>
    reply.code(501).send({ error: 'Not implemented in milestone 1' }),
  );
};

export default identifyRoutes;
