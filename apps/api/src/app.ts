import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import staticPlugin from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { env, isProduction } from './env.js';
import { resolveUploadsDir } from './lib/storage.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import externalSightingsRoutes from './routes/external-sightings.js';
import healthRoutes from './routes/health.js';
import identifyRoutes from './routes/identify.js';
import sightingPhotosRoutes from './routes/sighting-photos.js';
import sightingsRoutes from './routes/sightings.js';
import whalesRoutes from './routes/whales.js';

export interface BuildAppOptions {
  silent?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.silent
      ? false
      : isProduction
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
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB per file
      files: 1,
    },
  });

  if (env.STORAGE_BACKEND === 'local') {
    const uploadsRoot = resolveUploadsDir();
    await mkdir(uploadsRoot, { recursive: true });
    await app.register(staticPlugin, {
      root: uploadsRoot,
      prefix: '/uploads/',
      decorateReply: false,
      // Photos are immutable once uploaded (filenames are content-hashed) so
      // long-cache them; if a photo is replaced, it gets a new filename.
      cacheControl: true,
      maxAge: '7d',
    });
  }

  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(whalesRoutes, { prefix: '/api/v1' });
  await app.register(sightingsRoutes, { prefix: '/api/v1' });
  await app.register(sightingPhotosRoutes, { prefix: '/api/v1' });
  await app.register(externalSightingsRoutes, { prefix: '/api/v1' });
  await app.register(identifyRoutes, { prefix: '/api/v1' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });

  return app;
}
