import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import staticPlugin from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { prisma } from './db.js';
import { env, isProduction } from './env.js';
import {
  features as environmentFeatures,
  validateFeatureConfig,
  type FeatureConfig,
} from './features.js';
import { resolveUploadsDir } from './lib/storage.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import capabilitiesRoutes from './routes/capabilities.js';
import externalSightingsRoutes from './routes/external-sightings.js';
import healthRoutes, { type ReadinessProbe } from './routes/health.js';
import identifyRoutes from './routes/identify.js';
import predictRoutes from './routes/predict.js';
import sightingPhotosRoutes from './routes/sighting-photos.js';
import sightingSubmissionRoutes from './routes/sighting-submissions.js';
import sightingsRoutes from './routes/sightings.js';
import whalesRoutes from './routes/whales.js';

export interface BuildAppOptions {
  readonly features?: FeatureConfig;
  readonly readinessProbe?: ReadinessProbe;
  readonly silent?: boolean;
}

const READINESS_TIMEOUT_MS = 5_000;

async function defaultReadinessProbe(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Database readiness probe timed out')), READINESS_TIMEOUT_MS);
    timeout.unref();
  });

  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const resolvedOptions = Object.freeze({
    features: validateFeatureConfig(options.features ?? environmentFeatures),
    readinessProbe: options.readinessProbe ?? defaultReadinessProbe,
    silent: options.silent ?? false,
  });
  const app = Fastify({
    logger: resolvedOptions.silent
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
  const requiresMultipart = resolvedOptions.features.accounts
    || resolvedOptions.features.identification
    || resolvedOptions.features.submissions;
  if (requiresMultipart) {
    await app.register(multipart, {
      limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB per file
        files: 1,
      },
    });
  }

  if (resolvedOptions.features.submissions && env.STORAGE_BACKEND === 'local') {
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

  await app.register(healthRoutes, {
    prefix: '/api/v1',
    readinessProbe: resolvedOptions.readinessProbe,
  });
  await app.register(capabilitiesRoutes, {
    prefix: '/api/v1',
    features: resolvedOptions.features,
  });
  await app.register(whalesRoutes, { prefix: '/api/v1' });
  await app.register(sightingsRoutes, { prefix: '/api/v1' });
  await app.register(externalSightingsRoutes, { prefix: '/api/v1' });
  await app.register(predictRoutes, { prefix: '/api/v1' });
  if (resolvedOptions.features.submissions) {
    await app.register(sightingSubmissionRoutes, { prefix: '/api/v1' });
  }
  if (resolvedOptions.features.submissions || resolvedOptions.features.accounts) {
    await app.register(sightingPhotosRoutes, {
      prefix: '/api/v1',
      accounts: resolvedOptions.features.accounts,
      submissions: resolvedOptions.features.submissions,
    });
  }
  if (resolvedOptions.features.identification) {
    await app.register(identifyRoutes, { prefix: '/api/v1' });
  }
  if (resolvedOptions.features.accounts) {
    await app.register(authRoutes, { prefix: '/api/v1/auth' });
    await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  }

  return app;
}
