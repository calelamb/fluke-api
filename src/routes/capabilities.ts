import type { FastifyPluginAsync } from 'fastify';
import {
  type Capabilities,
} from '../contracts/index.js';
import type { FeatureConfig } from '../features.js';

interface CapabilitiesRouteOptions {
  readonly features: FeatureConfig;
}

const capabilitiesRoutes: FastifyPluginAsync<CapabilitiesRouteOptions> = async (fastify, options) => {
  fastify.get('/capabilities', async (): Promise<Capabilities> => ({
    ...options.features,
  }));
};

export default capabilitiesRoutes;
