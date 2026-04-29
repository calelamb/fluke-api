import type { AdminClaims } from '../lib/auth.js';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { prisma } from '../db.js';
import { requireAdmin } from '../lib/auth.js';
import { buildPhotoFilename, getStorageBackend } from '../lib/storage.js';

const MAX_PHOTOS_PER_SIGHTING = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PUBLIC_UPLOAD_WINDOW_MS = 30 * 60 * 1000; // 30 minutes after sighting create

async function getOptionalAdmin(req: FastifyRequest): Promise<AdminClaims | null> {
  try {
    return await req.jwtVerify<AdminClaims>();
  } catch {
    return null;
  }
}

const sightingPhotosRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Photo upload route. Same path used for both public submitters and
   * admins; the auth check is opportunistic:
   *   - admin cookie present -> no time window, no per-request rate limit
   *     beyond what the route declares.
   *   - no auth -> sighting must be PENDING and created within the last
   *     30 minutes; per-IP rate limit applies.
   * Both paths share the same multipart parsing and sharp pipeline.
   */
  fastify.post<{ Params: { id: string } }>(
    '/sightings/:id/photos',
    {
      config: {
        rateLimit: { max: 25, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const { id: sightingId } = request.params;
      const admin = await getOptionalAdmin(request);

      const sighting = await prisma.sighting.findUnique({ where: { id: sightingId } });
      if (!sighting) {
        return reply.code(404).send({ error: 'Sighting not found' });
      }

      // Public uploads have to land within the submission window and only on
      // PENDING rows. Admins skip this gate.
      if (!admin) {
        if (sighting.status !== 'PENDING') {
          return reply
            .code(403)
            .send({ error: 'This sighting is no longer accepting photo uploads.' });
        }
        const ageMs = Date.now() - sighting.createdAt.getTime();
        if (ageMs > PUBLIC_UPLOAD_WINDOW_MS) {
          return reply
            .code(403)
            .send({ error: 'Photo upload window has closed for this sighting.' });
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
        const pipeline = sharp(buffer).rotate(); // honor EXIF orientation
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

      const [largeStored, thumbStored] = await Promise.all([
        storage.put({ prefix, filename: largeName, contentType: 'image/webp', body: largeBuffer }),
        storage.put({ prefix, filename: thumbName, contentType: 'image/webp', body: thumbBuffer }),
      ]);

      const photo = await prisma.sightingPhoto.create({
        data: {
          sightingId,
          storageKey: largeStored.key,
          url: largeStored.url,
          thumbnailUrl: thumbStored.url,
          orderIndex: existingCount,
        },
      });

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
              largeKey: largeStored.key,
              thumbKey: thumbStored.key,
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

  fastify.get<{ Params: { id: string } }>(
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
