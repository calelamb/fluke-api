import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAdmin, resolveOptionalAdmin, type AdminClaims } from '../lib/auth.js';
import { requireCsrf } from '../lib/csrf.js';
import { resolveOptionalObserver } from '../lib/observer-auth.js';
import { IdempotencyConflictError } from '../lib/idempotency.js';
import { buildPhotoFilename, type StorageBackend } from '../lib/storage.js';
import { cleanupPhotoObjects, storePhotoPair } from '../services/sighting-photo-storage.js';
import {
  PHOTO_UPLOAD_TOKEN_TYPE,
  type PhotoUploadTokenPayload,
} from './sighting-submissions.js';

const MAX_PHOTOS_PER_SIGHTING = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PHOTO_UPLOAD_TOKEN_HEADER = 'x-photo-upload-token';
const MAX_INPUT_PIXELS = 40_000_000;

function mediaUrl(photoId: string, thumbnail = false): string {
  const origin = env.API_PUBLIC_ORIGIN.replace(/\/$/u, '');
  const query = thumbnail ? '?variant=thumbnail' : '';
  return `${origin}/api/v1/media/${photoId}${query}`;
}

function thumbnailKey(largeKey: string): string {
  if (!largeKey.endsWith('-1024.webp')) throw new Error('Invalid sighting photo storage key');
  return `${largeKey.slice(0, -'-1024.webp'.length)}-256.webp`;
}

/**
 * Verifies a `X-Photo-Upload-Token` header (if present) against the path's
 * sighting id. Returns true only when the token is valid, scoped to this
 * sighting, and carries the photo-upload type claim. A missing header
 * returns false; a malformed/expired/mismatched token also returns false
 * (the caller decides how to fall back).
 */
function verifyPhotoUploadToken(
  fastify: FastifyInstance,
  req: FastifyRequest,
  sightingId: string,
): { ok: true; payload: PhotoUploadTokenPayload } | { ok: false; reason: 'missing' | 'invalid' } {
  const raw = req.headers[PHOTO_UPLOAD_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return { ok: false, reason: 'missing' };
  try {
    const payload = fastify.jwt.verify<PhotoUploadTokenPayload>(token);
    if (payload.type !== PHOTO_UPLOAD_TOKEN_TYPE) {
      return { ok: false, reason: 'invalid' };
    }
    if (payload.sightingId !== sightingId) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

interface UploadAuthorization {
  readonly admin: AdminClaims | null;
  readonly clientSubmissionId: string | null;
  readonly sightingId: string;
}

interface SourcePhoto {
  readonly body: Buffer;
  readonly filename: string;
}

interface PhotoVariants {
  readonly baseFilename: string;
  readonly large: Buffer;
  readonly thumbnail: Buffer;
}

interface PhotoIdempotency {
  readonly photoId: string;
  readonly requestHash: string;
}

class PhotoLimitError extends Error {
  readonly statusCode = 400;

  constructor() {
    super('Photo limit reached');
    this.name = 'PhotoLimitError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function deterministicPhotoId(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function resolvePhotoIdempotency(
  request: FastifyRequest,
  authorization: UploadAuthorization,
  source: SourcePhoto,
): PhotoIdempotency | null {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (authorization.clientSubmissionId === null && value === undefined) return null;
  if (typeof value !== 'string') throw new IdempotencyConflictError();
  const [submissionId, photoId, extra] = value.split(':');
  if (extra !== undefined || !UUID_PATTERN.test(submissionId) || !UUID_PATTERN.test(photoId)) {
    throw new IdempotencyConflictError();
  }
  if (authorization.clientSubmissionId !== null && submissionId !== authorization.clientSubmissionId) {
    throw new IdempotencyConflictError();
  }
  return Object.freeze({
    photoId: deterministicPhotoId(`${authorization.sightingId}\0${value}`),
    requestHash: createHash('sha256').update(source.body).digest('hex'),
  });
}

function photoResponse(photo: {
  readonly id: string;
  readonly orderIndex: number;
  readonly thumbnailUrl: string;
  readonly url: string;
}) {
  return Object.freeze({
    id: photo.id,
    orderIndex: photo.orderIndex,
    thumbnailUrl: photo.thumbnailUrl,
    url: photo.url,
  });
}

async function findPhotoReplayWithClient(
  database: Pick<Prisma.TransactionClient, 'sightingPhoto'>,
  idempotency: PhotoIdempotency | null,
  authorization: UploadAuthorization,
) {
  if (idempotency === null) return null;
  const existing = await database.sightingPhoto.findUnique({ where: { id: idempotency.photoId } });
  if (existing === null) return null;
  const fingerprint = `${idempotency.requestHash}-${idempotency.photoId.slice(0, 8)}`;
  if (existing.sightingId !== authorization.sightingId || !existing.storageKey.includes(fingerprint)) {
    throw new IdempotencyConflictError();
  }
  return existing;
}

async function authorizePhotoUpload(
  fastify: FastifyInstance,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<UploadAuthorization | null> {
  const sightingId = request.params.id;
  const admin = await resolveOptionalAdmin(request);
  const observer = admin === null ? await resolveOptionalObserver(request, reply) : null;
  const token = verifyPhotoUploadToken(fastify, request, sightingId);
  if (!token.ok && token.reason === 'invalid') {
    reply.code(403).send({ error: 'Invalid photo upload token.' });
    return null;
  }
  const sighting = await prisma.sighting.findUnique({ where: { id: sightingId } });
  if (!sighting) {
    reply.code(404).send({ error: 'Sighting not found' });
    return null;
  }
  if (!admin && sighting.status !== 'PENDING') {
    reply.code(403).send({ error: 'This sighting is not accepting photo uploads.' });
    return null;
  }
  if (!admin && !token.ok) {
    if (observer === null || observer.id !== sighting.observerUserId) {
      reply.code(403).send({ error: 'This sighting is not accepting photo uploads.' });
      return null;
    }
    await requireCsrf(request, reply);
  }
  return Object.freeze({
    admin,
    clientSubmissionId: token.ok ? token.payload.clientSubmissionId ?? null : null,
    sightingId,
  });
}

async function readSourcePhoto(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SourcePhoto | null> {
  const file = await request.file();
  if (!file) {
    reply.code(400).send({ error: 'Multipart file required' });
    return null;
  }
  if (!ACCEPTED_MIME.has(file.mimetype)) {
    reply.code(415).send({ error: 'Unsupported photo content type' });
    return null;
  }
  const body = await file.toBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_FILE_BYTES) {
    reply.code(body.byteLength === 0 ? 400 : 413).send({ error: 'Invalid photo size' });
    return null;
  }
  return Object.freeze({ body, filename: file.filename || 'upload.jpg' });
}

async function processPhoto(source: SourcePhoto): Promise<PhotoVariants> {
  const pipeline = sharp(source.body, {
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
  }).rotate();
  const [large, thumbnail] = await Promise.all([
    pipeline.clone().resize({ width: 1024, withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer(),
    pipeline.clone().resize({ width: 256, withoutEnlargement: true })
      .webp({ quality: 78 }).toBuffer(),
  ]);
  return Object.freeze({
    baseFilename: buildPhotoFilename(source.filename, source.body),
    large,
    thumbnail,
  });
}

async function persistPhoto(
  request: FastifyRequest,
  authorization: UploadAuthorization,
  variants: PhotoVariants,
  idempotency: PhotoIdempotency | null,
  storage: StorageBackend,
  database: Pick<Prisma.TransactionClient, 'sightingPhoto'> = prisma,
  onStored?: (keys: readonly string[]) => void,
): Promise<Awaited<ReturnType<typeof prisma.sightingPhoto.create>>> {
  const prefix = `sightings/${authorization.sightingId}`;
  const photoId = idempotency?.photoId ?? randomUUID();
  const stem = idempotency === null
    ? variants.baseFilename.replace(/\.[^./]+$/u, '')
    : `${idempotency.requestHash}-${photoId.slice(0, 8)}`;
  const existingCount = await database.sightingPhoto.count({
    where: { sightingId: authorization.sightingId },
  });
  if (existingCount >= MAX_PHOTOS_PER_SIGHTING) throw new PhotoLimitError();
  let photo: Awaited<ReturnType<typeof prisma.sightingPhoto.create>> | undefined;
  const pair = await storePhotoPair({
    createPhoto: async ({ large }) => {
      photo = await database.sightingPhoto.create({
        data: {
          id: photoId,
          orderIndex: existingCount,
          sightingId: authorization.sightingId,
          storageKey: large.key,
          thumbnailUrl: mediaUrl(photoId, true),
          url: mediaUrl(photoId),
        },
      });
    },
    large: { body: variants.large, contentType: 'image/webp', filename: `${stem}-1024.webp`, prefix },
    recordCleanupFailure: (failure) => request.log.error(
      failure, 'sighting photo compensation failed',
    ),
    storage,
    thumbnail: { body: variants.thumbnail, contentType: 'image/webp', filename: `${stem}-256.webp`, prefix },
  });
  onStored?.([pair.large.key, pair.thumbnail.key]);
  if (!photo) throw new Error('Photo persistence did not complete');
  return photo;
}

interface PersistedPhotoResult {
  readonly photo: Awaited<ReturnType<typeof prisma.sightingPhoto.create>>;
  readonly replayed: boolean;
}

async function persistIdempotentPhoto(
  request: FastifyRequest,
  authorization: UploadAuthorization,
  variants: PhotoVariants,
  idempotency: PhotoIdempotency,
  storage: StorageBackend,
): Promise<PersistedPhotoResult> {
  let storedKeys: readonly string[] = [];
  try {
    return await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${idempotency.photoId}, 0))`;
      const replay = await findPhotoReplayWithClient(transaction, idempotency, authorization);
      if (replay !== null) return Object.freeze({ photo: replay, replayed: true });
      const photo = await persistPhoto(
        request, authorization, variants, idempotency, storage, transaction,
        (keys) => { storedKeys = keys; },
      );
      return Object.freeze({ photo, replayed: false });
    });
  } catch (error: unknown) {
    if (storedKeys.length > 0) {
      await cleanupPhotoObjects(storage, storedKeys, (failure) => request.log.error(
        failure, 'sighting photo transaction compensation failed',
      ));
    }
    throw error;
  }
}

async function recordAdminPhotoAudit(
  admin: AdminClaims | null,
  photoId: string,
  sightingId: string,
  sizeBytes: number,
): Promise<void> {
  if (!admin) return;
  await prisma.auditLog.create({
    data: {
      action: 'UPLOAD_SIGHTING_PHOTO',
      entityId: photoId,
      entityType: 'sighting_photo',
      metadata: { sightingId, sizeBytes },
      userId: admin.userId,
    },
  });
}

async function handlePhotoUpload(
  fastify: FastifyInstance,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  storage: StorageBackend,
): Promise<unknown> {
  const authorization = await authorizePhotoUpload(fastify, request, reply);
  if (!authorization) return reply;
  const source = await readSourcePhoto(request, reply);
  if (!source) return reply;
  const idempotency = resolvePhotoIdempotency(request, authorization, source);
  let variants: PhotoVariants;
  try {
    variants = await processPhoto(source);
  } catch {
    request.log.warn({ failureKind: 'photo-validation' }, 'photo processing rejected');
    return reply.code(400).send({ error: 'Photo could not be processed' });
  }
  const persisted = idempotency === null
    ? Object.freeze({
      photo: await persistPhoto(request, authorization, variants, null, storage), replayed: false,
    })
    : await persistIdempotentPhoto(request, authorization, variants, idempotency, storage);
  const photo = persisted.photo;
  await recordAdminPhotoAudit(
    authorization.admin, photo.id, authorization.sightingId, source.body.byteLength,
  );
  return reply.code(persisted.replayed ? 200 : 201).send(photoResponse(photo));
}

interface SightingPhotosRouteOptions {
  readonly accounts: boolean;
  readonly storage: () => StorageBackend;
  readonly submissions: boolean;
}

const sightingPhotosRoutes: FastifyPluginAsync<SightingPhotosRouteOptions> = async (fastify, options) => {
  /**
   * Photo upload route. Same path used for both public submitters and
   * admins; the auth check is opportunistic:
   *   - admin cookie present -> no time window, no per-request rate limit
   *     beyond what the route declares.
   *   - a sighting-scoped upload token, or the owning observer plus CSRF,
   *     is required for non-admin uploads.
   * Both paths share the same multipart parsing and sharp pipeline.
   */
  if (options.submissions) fastify.post<{ Params: { id: string } }>(
    '/sightings/:id/photos',
    {
      config: {
        rateLimit: { max: 25, timeWindow: '1 hour' },
      },
    },
    (request, reply) => handlePhotoUpload(fastify, request, reply, options.storage()),
  );

  fastify.get<{ Params: { photoId: string }; Querystring: { variant?: string } }>(
    '/media/:photoId',
    async (request, reply) => {
      if (request.query.variant !== undefined && request.query.variant !== 'thumbnail') {
        return reply.code(400).send({ error: 'Invalid media variant' });
      }
      const admin = await resolveOptionalAdmin(request);
      const observer = admin ? null : await resolveOptionalObserver(request, reply);
      const photo = await prisma.sightingPhoto.findUnique({
        where: { id: request.params.photoId },
        select: {
          storageKey: true,
          sighting: { select: { observerUserId: true, status: true } },
        },
      });
      if (photo === null) return reply.code(404).send({ error: 'Media not found' });

      const mayRead = photo.sighting.status === 'APPROVED'
        || admin !== null
        || (observer !== null && photo.sighting.observerUserId === observer.id);
      if (!mayRead) return reply.code(403).send({ error: 'Media is private' });

      const key = request.query.variant === 'thumbnail'
        ? thumbnailKey(photo.storageKey)
        : photo.storageKey;
      const storage = options.storage();
      const location = storage.signedReadUrl
        ? await storage.signedReadUrl(key)
        : storage.publicUrl(key);
      return reply.redirect(location);
    },
  );

  if (options.accounts) fastify.get<{ Params: { id: string } }>(
    '/sightings/:id/photos',
    { preHandler: requireAdmin },
    async (request) => {
      const photos = await prisma.sightingPhoto.findMany({
        where: { sightingId: request.params.id },
        orderBy: { orderIndex: 'asc' },
      });
      return photos.map((photo) => ({
        id: photo.id,
        url: photo.url,
        thumbnailUrl: photo.thumbnailUrl,
        orderIndex: photo.orderIndex,
      }));
    },
  );
};

export default sightingPhotosRoutes;
