import type { FastifyPluginAsync } from 'fastify';
import {
  RELEASE_A_CAPABILITIES,
  type Capabilities,
} from '../contracts/index.js';

const capabilitiesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/capabilities', async (): Promise<Capabilities> => ({
    ...RELEASE_A_CAPABILITIES,
  }));
};

export default capabilitiesRoutes;
