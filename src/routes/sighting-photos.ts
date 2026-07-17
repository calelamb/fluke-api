import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAdmin, resolveOptionalAdmin, type AdminClaims } from '../lib/auth.js';
import { resolveOptionalObserver } from '../lib/observer-auth.js';
import { buildPhotoFilename, getStorageBackend } from '../lib/storage.js';
import { storePhotoPair } from '../services/sighting-photo-storage.js';
import {
  PHOTO_UPLOAD_TOKEN_TYPE,
  type PhotoUploadTokenPayload,
} from './sighting-submissions.js';

const MAX_PHOTOS_PER_SIGHTING = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PUBLIC_UPLOAD_WINDOW_MS = 30 * 60 * 1000; // 30 minutes after sighting create
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
): { ok: true } | { ok: false; reason: 'missing' | 'invalid' } {
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
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

interface UploadAuthorization {
  readonly admin: AdminClaims | null;
  readonly existingCount: number;
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

async function authorizePhotoUpload(
  fastify: FastifyInstance,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<UploadAuthorization | null> {
  const sightingId = request.params.id;
  const admin = await resolveOptionalAdmin(request);
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
  const expired = Date.now() - sighting.createdAt.getTime() > PUBLIC_UPLOAD_WINDOW_MS;
  if (!admin && (sighting.status !== 'PENDING' || (!token.ok && expired))) {
    reply.code(403).send({ error: 'This sighting is not accepting photo uploads.' });
    return null;
  }
  const existingCount = await prisma.sightingPhoto.count({ where: { sightingId } });
  if (existingCount >= MAX_PHOTOS_PER_SIGHTING) {
    reply.code(400).send({ error: 'This sighting already has the maximum number of photos.' });
    return null;
  }
  return Object.freeze({ admin, existingCount, sightingId });
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
): Promise<Awaited<ReturnType<typeof prisma.sightingPhoto.create>>> {
  const storage = getStorageBackend();
  const prefix = `sightings/${authorization.sightingId}`;
  const stem = variants.baseFilename.replace(/\.[^./]+$/u, '');
  const photoId = randomUUID();
  let photo: Awaited<ReturnType<typeof prisma.sightingPhoto.create>> | undefined;
  await storePhotoPair({
    createPhoto: async ({ large }) => {
      photo = await prisma.sightingPhoto.create({
        data: {
          id: photoId,
          orderIndex: authorization.existingCount,
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
  if (!photo) throw new Error('Photo persistence did not complete');
  return photo;
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
): Promise<unknown> {
  const authorization = await authorizePhotoUpload(fastify, request, reply);
  if (!authorization) return reply;
  const source = await readSourcePhoto(request, reply);
  if (!source) return reply;
  let variants: PhotoVariants;
  try {
    variants = await processPhoto(source);
  } catch {
    request.log.warn({ failureKind: 'photo-validation' }, 'photo processing rejected');
    return reply.code(400).send({ error: 'Photo could not be processed' });
  }
  const photo = await persistPhoto(request, authorization, variants);
  await recordAdminPhotoAudit(
    authorization.admin, photo.id, authorization.sightingId, source.body.byteLength,
  );
  return reply.code(201).send({
    id: photo.id,
    orderIndex: photo.orderIndex,
    thumbnailUrl: photo.thumbnailUrl,
    url: photo.url,
  });
}

interface SightingPhotosRouteOptions {
  readonly accounts: boolean;
  readonly submissions: boolean;
}

const sightingPhotosRoutes: FastifyPluginAsync<SightingPhotosRouteOptions> = async (fastify, options) => {
  /**
   * Photo upload route. Same path used for both public submitters and
   * admins; the auth check is opportunistic:
   *   - admin cookie present -> no time window, no per-request rate limit
   *     beyond what the route declares.
   *   - no auth -> sighting must be PENDING and created within the last
   *     30 minutes; per-IP rate limit applies.
   * Both paths share the same multipart parsing and sharp pipeline.
   */
  if (options.submissions) fastify.post<{ Params: { id: string } }>(
    '/sightings/:id/photos',
    {
      config: {
        rateLimit: { max: 25, timeWindow: '1 hour' },
      },
    },
    (request, reply) => handlePhotoUpload(fastify, request, reply),
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

      const storage = getStorageBackend();
      const key = request.query.variant === 'thumbnail'
        ? thumbnailKey(photo.storageKey)
        : photo.storageKey;
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
