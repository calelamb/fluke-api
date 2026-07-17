import type { FastifyPluginAsync } from 'fastify';
import {
  CapabilitiesSchema,
} from '../contracts/index.js';
import type { FeatureConfig } from '../features.js';
import {
  CATALOG_CACHE_POLICY,
  sendPublicResponse,
} from '../lib/public-response.js';

interface CapabilitiesRouteOptions {
  readonly features: FeatureConfig;
}

const capabilitiesRoutes: FastifyPluginAsync<CapabilitiesRouteOptions> = async (fastify, options) => {
  fastify.get('/capabilities', async (request, reply) => sendPublicResponse(
    request,
    reply,
    CapabilitiesSchema,
    { ...options.features },
    CATALOG_CACHE_POLICY,
  ));
};

export default capabilitiesRoutes;
