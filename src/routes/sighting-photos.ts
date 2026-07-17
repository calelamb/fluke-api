import type { AdminClaims } from '../lib/auth.js';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAdmin } from '../lib/auth.js';
import { resolveOptionalObserver } from '../lib/observer-auth.js';
import { buildPhotoFilename, getStorageBackend } from '../lib/storage.js';
import type { StorageBackend, StoredObject } from '../lib/storage.js';
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

interface StoredPhotoPair {
  readonly large: StoredObject;
  readonly thumbnail: StoredObject;
}

async function cleanupObjects(storage: StorageBackend, keys: readonly string[]): Promise<void> {
  await Promise.allSettled(keys.map((key) => storage.remove(key)));
}

export async function storePhotoPair(input: {
  readonly createPhoto: (pair: StoredPhotoPair) => Promise<unknown>;
  readonly large: Parameters<StorageBackend['put']>[0];
  readonly storage: StorageBackend;
  readonly thumbnail: Parameters<StorageBackend['put']>[0];
}): Promise<StoredPhotoPair> {
  const large = await input.storage.put(input.large);
  let thumbnail: StoredObject;
  try {
    thumbnail = await input.storage.put(input.thumbnail);
  } catch (error: unknown) {
    await cleanupObjects(input.storage, [large.key]);
    throw error;
  }

  const pair = Object.freeze({ large, thumbnail });
  try {
    await input.createPhoto(pair);
    return pair;
  } catch (error: unknown) {
    await cleanupObjects(input.storage, [large.key, thumbnail.key]);
    throw error;
  }
}

function mediaUrl(photoId: string, thumbnail = false): string {
  const origin = env.API_PUBLIC_ORIGIN.replace(/\/$/u, '');
  const query = thumbnail ? '?variant=thumbnail' : '';
  return `${origin}/api/v1/media/${photoId}${query}`;
}

function thumbnailKey(largeKey: string): string {
  if (!largeKey.endsWith('-1024.webp')) throw new Error('Invalid sighting photo storage key');
  return `${largeKey.slice(0, -'-1024.webp'.length)}-256.webp`;
}

async function getOptionalAdmin(req: FastifyRequest): Promise<AdminClaims | null> {
  try {
    return await req.jwtVerify<AdminClaims>();
  } catch {
    return null;
  }
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
    async (request, reply) => {
      const { id: sightingId } = request.params;
      const admin = await getOptionalAdmin(request);
      const tokenResult = verifyPhotoUploadToken(fastify, request, sightingId);

      // If a token header was supplied but failed verification (mismatched
      // sighting id, wrong type, expired, malformed), reject before doing any
      // DB work. This makes offline-replay failures explicit and observable.
      if (tokenResult.ok === false && tokenResult.reason === 'invalid') {
        return reply.code(403).send({ error: 'Invalid photo upload token.' });
      }

      const sighting = await prisma.sighting.findUnique({ where: { id: sightingId } });
      if (!sighting) {
        return reply.code(404).send({ error: 'Sighting not found' });
      }

      // Public uploads have to land within the submission window and only on
      // PENDING rows. Admins skip this gate. A valid signed photo-upload token
      // also bypasses the time-window check (but still requires PENDING) so
      // queued offline submissions can replay past the 30-minute mark.
      if (!admin) {
        if (sighting.status !== 'PENDING') {
          return reply
            .code(403)
            .send({ error: 'This sighting is no longer accepting photo uploads.' });
        }
        if (!tokenResult.ok) {
          const ageMs = Date.now() - sighting.createdAt.getTime();
          if (ageMs > PUBLIC_UPLOAD_WINDOW_MS) {
            return reply
              .code(403)
              .send({ error: 'Photo upload window has closed for this sighting.' });
          }
        }
      }

      const existingCount = await prisma.sightingPhoto.count({ where: { sightingId } });
      if (existingCount >= MAX_PHOTOS_PER_SIGHTING) {
        return reply
          .code(400)
          .send({ error: `Sighting already has ${existingCount} photos (max ${MAX_PHOTOS_PER_SIGHTING}).` });
      }

      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: 'Multipart file required' });
      }

      if (!ACCEPTED_MIME.has(file.mimetype)) {
        return reply.code(415).send({ error: `Unsupported content type: ${file.mimetype}` });
      }

      const buffer = await file.toBuffer();
      if (buffer.byteLength === 0) {
        return reply.code(400).send({ error: 'Empty file' });
      }
      if (buffer.byteLength > MAX_FILE_BYTES) {
        return reply.code(413).send({ error: `File exceeds ${MAX_FILE_BYTES} bytes.` });
      }

      const originalFilename = file.filename || 'upload.jpg';
      const baseFilename = buildPhotoFilename(originalFilename, buffer);

      let largeBuffer: Buffer;
      let thumbBuffer: Buffer;
      try {
        const pipeline = sharp(buffer, {
          failOn: 'error',
          limitInputPixels: MAX_INPUT_PIXELS,
        }).rotate();
        largeBuffer = await pipeline
          .clone()
          .resize({ width: 1024, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        thumbBuffer = await pipeline
          .clone()
          .resize({ width: 256, withoutEnlargement: true })
          .webp({ quality: 78 })
          .toBuffer();
      } catch (error) {
        request.log.error({ error }, 'sharp failed to process photo');
        return reply.code(400).send({ error: 'Photo could not be processed' });
      }

      const storage = getStorageBackend();
      const prefix = `sightings/${sightingId}`;

      const stem = baseFilename.replace(/\.[^./]+$/, '');
      const largeName = `${stem}-1024.webp`;
      const thumbName = `${stem}-256.webp`;

      const photoId = randomUUID();
      let photo: Awaited<ReturnType<typeof prisma.sightingPhoto.create>> | undefined;
      await storePhotoPair({
        createPhoto: async ({ large }) => {
          photo = await prisma.sightingPhoto.create({
            data: {
              id: photoId,
              sightingId,
              storageKey: large.key,
              url: mediaUrl(photoId),
              thumbnailUrl: mediaUrl(photoId, true),
              orderIndex: existingCount,
            },
          });
        },
        large: { prefix, filename: largeName, contentType: 'image/webp', body: largeBuffer },
        storage,
        thumbnail: { prefix, filename: thumbName, contentType: 'image/webp', body: thumbBuffer },
      });
      if (photo === undefined) throw new Error('Photo persistence did not complete');

      // Audit log only for admin uploads — public submissions are tracked via
      // the Sighting row itself; the SightingPhoto row carries its provenance.
      if (admin) {
        await prisma.auditLog.create({
          data: {
            userId: admin.userId,
            action: 'UPLOAD_SIGHTING_PHOTO',
            entityType: 'sighting_photo',
            entityId: photo.id,
            metadata: {
              sightingId,
              sizeBytes: buffer.byteLength,
            },
          },
        });
      }

      return reply.code(201).send({
        id: photo.id,
        url: photo.url,
        thumbnailUrl: photo.thumbnailUrl,
        orderIndex: photo.orderIndex,
      });
    },
  );

  fastify.get<{ Params: { photoId: string }; Querystring: { variant?: string } }>(
    '/media/:photoId',
    async (request, reply) => {
      if (request.query.variant !== undefined && request.query.variant !== 'thumbnail') {
        return reply.code(400).send({ error: 'Invalid media variant' });
      }
      const admin = await getOptionalAdmin(request);
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
