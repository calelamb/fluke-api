import type { FastifyPluginAsync } from 'fastify';
import sharp from 'sharp';
import { prisma } from '../db.js';
import { requireAdmin } from '../lib/auth.js';
import { buildPhotoFilename, getStorageBackend } from '../lib/storage.js';

const MAX_PHOTOS_PER_SIGHTING = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const sightingPhotosRoutes: FastifyPluginAsync = async (fastify) => {
  // Admin-only for now; the public submission flow will get its own
  // unauthenticated multipart variant once the signed-token confirmation work
  // for /submit lands.
  fastify.post<{ Params: { id: string } }>(
    '/sightings/:id/photos',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { id: sightingId } = request.params;

      const sighting = await prisma.sighting.findUnique({ where: { id: sightingId } });
      if (!sighting) {
        return reply.code(404).send({ error: 'Sighting not found' });
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

      await prisma.auditLog.create({
        data: {
          userId: request.admin!.userId,
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
