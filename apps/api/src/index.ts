import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import identifyRoutes from './routes/identify.js';
import sightingsRoutes from './routes/sightings.js';
import whalesRoutes from './routes/whales.js';

dotenv.config();

const { env, isProduction } = await import('./env.js');

const app = Fastify({
  logger: isProduction
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
  origin: env.WEB_ORIGIN,
  credentials: true,
});
await app.register(cookie);
await app.register(jwt, {
  secret: env.JWT_SECRET,
  cookie: {
    cookieName: env.ADMIN_COOKIE_NAME,
    signed: false,
  },
});
await app.register(rateLimit, { global: false });
await app.register(sensible);
await app.register(healthRoutes, { prefix: '/api/v1' });
await app.register(whalesRoutes, { prefix: '/api/v1' });
await app.register(sightingsRoutes, { prefix: '/api/v1' });
await app.register(identifyRoutes, { prefix: '/api/v1' });
await app.register(authRoutes, { prefix: '/api/v1/auth' });
await app.register(adminRoutes, { prefix: '/api/v1/admin' });

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
