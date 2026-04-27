import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import healthRoutes from './routes/health.js';
import identifyRoutes from './routes/identify.js';
import sightingsRoutes from './routes/sightings.js';
import whalesRoutes from './routes/whales.js';

dotenv.config();

const { env } = await import('./env.js');

const app = Fastify({
  logger:
    process.env.NODE_ENV === 'production'
      ? true
      : {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
            },
          },
        },
});

await app.register(cors, {
  origin: ['http://localhost:5173'],
});
await app.register(sensible);
await app.register(healthRoutes, { prefix: '/api/v1' });
await app.register(whalesRoutes, { prefix: '/api/v1' });
await app.register(sightingsRoutes, { prefix: '/api/v1' });
await app.register(identifyRoutes, { prefix: '/api/v1' });

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
