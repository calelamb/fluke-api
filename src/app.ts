import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import staticPlugin from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { SafeErrorSchema } from './contracts/index.js';
import { prisma } from './db.js';
import { env, isProduction } from './env.js';
import {
  features as environmentFeatures,
  validateFeatureConfig,
  type FeatureConfig,
} from './features.js';
import { resolveUploadsDir } from './lib/storage.js';
import { resolveRequestId } from './lib/request-id.js';
import { classifyError, classifyStatus } from './lib/safe-errors.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import capabilitiesRoutes from './routes/capabilities.js';
import externalSightingsRoutes from './routes/external-sightings.js';
import healthRoutes, { type ReadinessProbe } from './routes/health.js';
import historicalSightingsRoutes from './routes/historical-sightings.js';
import identifyRoutes from './routes/identify.js';
import predictRoutes from './routes/predict.js';
import sightingPhotosRoutes from './routes/sighting-photos.js';
import sightingSubmissionRoutes from './routes/sighting-submissions.js';
import sightingsRoutes from './routes/sightings.js';
import whalesRoutes from './routes/whales.js';

export interface BuildAppOptions {
  readonly features?: FeatureConfig;
  readonly publicReadRateLimitMax?: number;
  readonly publicReadTimeoutMs?: number;
  readonly readinessProbe?: ReadinessProbe;
  readonly silent?: boolean;
  readonly trustProxy?: false | number;
}

const READINESS_TIMEOUT_MS = 5_000;
const PUBLIC_READ_RATE_LIMIT_MAX = 120;
const PUBLIC_READ_TIMEOUT_MS = 5_000;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isCanonicalSerializedError(payload: unknown, requestId: string): boolean {
  const serialized = typeof payload === 'string'
    ? payload
    : Buffer.isBuffer(payload)
      ? payload.toString('utf8')
      : undefined;
  if (serialized === undefined) {
    return false;
  }

  try {
    const parsed = SafeErrorSchema.safeParse(JSON.parse(serialized));
    return parsed.success && parsed.data.requestId === requestId;
  } catch {
    return false;
  }
}

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
    publicReadRateLimitMax: positiveInteger(
      options.publicReadRateLimitMax ?? PUBLIC_READ_RATE_LIMIT_MAX,
      'publicReadRateLimitMax',
    ),
    publicReadTimeoutMs: positiveInteger(
      options.publicReadTimeoutMs ?? PUBLIC_READ_TIMEOUT_MS,
      'publicReadTimeoutMs',
    ),
    readinessProbe: options.readinessProbe ?? defaultReadinessProbe,
    silent: options.silent ?? false,
    trustProxy: options.trustProxy ?? (isProduction ? 1 : false),
  });
  const app = Fastify({
    forceCloseConnections: 'idle',
    genReqId: (request) => resolveRequestId(request.headers['x-request-id']),
    handlerTimeout: resolvedOptions.publicReadTimeoutMs,
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
    trustProxy: resolvedOptions.trustProxy,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (reply.statusCode < 400) {
      return payload;
    }

    const failure = classifyStatus(reply.statusCode, request.id);
    const safePayload = SafeErrorSchema.safeParse(payload);
    if (
      failure.statusCode === reply.statusCode
      && safePayload.success
      && safePayload.data.requestId === request.id
    ) {
      return safePayload.data;
    }

    reply.code(failure.statusCode);
    const diagnostics = {
      failureKind: failure.kind,
      requestId: request.id,
      statusCode: failure.statusCode,
    };
    if (failure.statusCode >= 500) {
      request.log.error(diagnostics, 'request rejected');
    } else {
      request.log.warn(diagnostics, 'request rejected');
    }
    return failure.body;
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    if (reply.statusCode < 400) {
      done(null, payload);
      return;
    }

    const failure = classifyStatus(reply.statusCode, request.id);
    if (
      failure.statusCode === reply.statusCode
      && isCanonicalSerializedError(payload, request.id)
    ) {
      done(null, payload);
      return;
    }

    reply.code(failure.statusCode).type('application/json');
    const diagnostics = {
      failureKind: failure.kind,
      requestId: request.id,
      statusCode: failure.statusCode,
    };
    if (failure.statusCode >= 500) {
      request.log.error(diagnostics, 'non-canonical error response replaced');
    } else {
      request.log.warn(diagnostics, 'non-canonical error response replaced');
    }
    done(null, JSON.stringify(failure.body));
  });
  app.setNotFoundHandler(async (request, reply) => {
    const failure = classifyStatus(404, request.id);
    return reply.code(failure.statusCode).send(failure.body);
  });
  app.setErrorHandler(async (error, request, reply) => {
    const failure = classifyError(error, request.id);
    const diagnostics = {
      err: error,
      failureKind: failure.kind,
      requestId: request.id,
      statusCode: failure.statusCode,
    };
    if (failure.statusCode >= 500) {
      request.log.error(diagnostics, 'request failed');
    } else {
      request.log.warn(diagnostics, 'request failed');
    }
    return reply
      .code(failure.statusCode)
      .type('application/json')
      .send(failure.body);
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
  });
  await app.register(helmet);
  await app.register(compress, {
    global: true,
    globalDecompression: false,
    threshold: 1_024,
  });
  await app.register(cookie);
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: {
      cookieName: env.ADMIN_COOKIE_NAME,
      signed: false,
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: resolvedOptions.publicReadRateLimitMax,
    timeWindow: '1 minute',
  });
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
  await app.register(historicalSightingsRoutes, { prefix: '/api/v1' });
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
