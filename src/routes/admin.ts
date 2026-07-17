import type {
  LabelablePhotoDTO,
  PendingSightingDTO,
  PhotoAnnotationDTO,
  PhotoAnnotationPayload,
  WhaleReferencePhotoDTO,
} from '@fluke/shared';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAdmin } from '../lib/auth.js';
import { buildPhotoFilename, getStorageBackend } from '../lib/storage.js';

const PhotoQualityEnum = z.enum([
  'USABLE',
  'OCCLUDED',
  'MOTION_BLUR',
  'WRONG_ANGLE',
  'TOO_DISTANT',
  'NOT_ORCA',
]);

const ConfidenceEnum = z.enum(['CONFIRMED', 'LIKELY', 'ML_SUGGESTED']);
const ReferencePhotoSideEnum = z.enum(['LEFT', 'RIGHT', 'UNKNOWN']);
const EmbeddingStatusEnum = z.enum(['PENDING', 'EMBEDDED', 'FAILED']);

const BoxSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});

const AnnotationPayloadSchema = z.object({
  dorsal_fin: BoxSchema.optional(),
  saddle_patch: BoxSchema.optional(),
});

const AnnotateBody = z.object({
  quality: PhotoQualityEnum,
  whaleCatalogId: z.string().min(1).optional().nullable(),
  confidence: ConfidenceEnum.optional().nullable(),
  payload: AnnotationPayloadSchema.optional(),
  notes: z.string().max(500).optional().nullable(),
  done: z.boolean().optional(),
});

function toAnnotationDTO(annotation: {
  id: string;
  photoId: string;
  version: number;
  quality: PhotoAnnotationDTO['quality'];
  payload: unknown;
  whale: { catalogId: string; name: string | null } | null;
  confidence: PhotoAnnotationDTO['confidence'];
  notes: string | null;
  done: boolean;
  labeledById: string;
  labeledAt: Date;
}): PhotoAnnotationDTO {
  const payload = (annotation.payload ?? {}) as PhotoAnnotationPayload;
  return {
    id: annotation.id,
    photoId: annotation.photoId,
    version: annotation.version,
    quality: annotation.quality,
    whaleCatalogId: annotation.whale?.catalogId ?? null,
    whaleName: annotation.whale?.name ?? null,
    confidence: annotation.confidence,
    payload,
    notes: annotation.notes,
    done: annotation.done,
    labeledById: annotation.labeledById,
    labeledAt: annotation.labeledAt.toISOString(),
  };
}

const StatusQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'),
});

function toPendingSightingDTO(sighting: {
  id: string;
  observedAt: Date;
  latitude: unknown;
  longitude: unknown;
  locationName: string | null;
  ecotypeGuess: PendingSightingDTO['ecotypeGuess'];
  groupSize: number | null;
  behaviorNotes: string | null;
  observerName: string | null;
  observerEmail: string;
  status: PendingSightingDTO['status'];
  createdAt: Date;
  whales: Array<{
    confidence: PendingSightingDTO['identifiedWhales'][number]['confidence'];
    whale: { catalogId: string; name: string | null };
  }>;
  photos: Array<{
    id: string;
    url: string;
    thumbnailUrl: string;
    orderIndex: number;
  }>;
}): PendingSightingDTO {
  return {
    id: sighting.id,
    observedAt: sighting.observedAt.toISOString(),
    latitude: Number(sighting.latitude),
    longitude: Number(sighting.longitude),
    locationName: sighting.locationName,
    ecotypeGuess: sighting.ecotypeGuess,
    groupSize: sighting.groupSize,
    behaviorNotes: sighting.behaviorNotes,
    observerName: sighting.observerName,
    observerEmail: sighting.observerEmail,
    status: sighting.status,
    createdAt: sighting.createdAt.toISOString(),
    identifiedWhales: sighting.whales.map((sightingWhale) => ({
      catalogId: sightingWhale.whale.catalogId,
      name: sightingWhale.whale.name,
      confidence: sightingWhale.confidence,
    })),
    photos: sighting.photos.map((photo) => ({
      id: photo.id,
      url: photo.url,
      thumbnailUrl: photo.thumbnailUrl,
      orderIndex: photo.orderIndex,
    })),
  };
}

function toReferencePhotoDTO(photo: {
  id: string;
  whaleId: string;
  url: string;
  side: WhaleReferencePhotoDTO['side'];
  quality: WhaleReferencePhotoDTO['quality'];
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
  embeddingStatus: WhaleReferencePhotoDTO['embeddingStatus'];
  notes: string | null;
  createdAt: Date;
  whale: { catalogId: string; name: string | null };
}): WhaleReferencePhotoDTO {
  return {
    id: photo.id,
    whaleId: photo.whaleId,
    catalogId: photo.whale.catalogId,
    whaleName: photo.whale.name,
    url: photo.url,
    side: photo.side,
    quality: photo.quality,
    cropX: photo.cropX,
    cropY: photo.cropY,
    cropWidth: photo.cropWidth,
    cropHeight: photo.cropHeight,
    embeddingStatus: photo.embeddingStatus,
    notes: photo.notes,
    createdAt: photo.createdAt.toISOString(),
  };
}

export default async function adminRoutes(app: FastifyInstance) {
  app.get('/sightings', { preHandler: requireAdmin }, async (req, reply): Promise<PendingSightingDTO[] | void> => {
    const parsed = StatusQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid status' });
    }

    const sightings = await prisma.sighting.findMany({
      where: { status: parsed.data.status },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        whales: { include: { whale: true } },
        photos: { orderBy: { orderIndex: 'asc' } },
      },
    });

    return sightings.map(toPendingSightingDTO);
  });

  app.post<{ Params: { id: string } }>('/sightings/:id/approve', { preHandler: requireAdmin }, async (req, reply) => {
    const sighting = await prisma.sighting.findUnique({ where: { id: req.params.id } });
    if (!sighting) return reply.code(404).send({ error: 'Not found' });

    await prisma.sighting.update({
      where: { id: req.params.id },
      data: {
        status: 'APPROVED',
        moderatedAt: new Date(),
        moderatedById: req.admin!.userId,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.admin!.userId,
        action: 'APPROVE_SIGHTING',
        entityType: 'sighting',
        entityId: req.params.id,
      },
    });

    return { ok: true };
  });

  const RejectBody = z.object({ reason: z.string().min(1).max(500) });

  app.post<{ Params: { id: string } }>('/sightings/:id/reject', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = RejectBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'reason required' });

    const sighting = await prisma.sighting.findUnique({ where: { id: req.params.id } });
    if (!sighting) return reply.code(404).send({ error: 'Not found' });

    await prisma.sighting.update({
      where: { id: req.params.id },
      data: {
        status: 'REJECTED',
        rejectionReason: parsed.data.reason,
        moderatedAt: new Date(),
        moderatedById: req.admin!.userId,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.admin!.userId,
        action: 'REJECT_SIGHTING',
        entityType: 'sighting',
        entityId: req.params.id,
        metadata: { reason: parsed.data.reason },
      },
    });

    return { ok: true };
  });

  const LinkBody = z.object({
    catalogId: z.string(),
    confidence: z.enum(['CONFIRMED', 'LIKELY', 'ML_SUGGESTED']),
  });

  app.post<{ Params: { id: string } }>('/sightings/:id/link-whale', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = LinkBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

    const sighting = await prisma.sighting.findUnique({ where: { id: req.params.id } });
    const whale = await prisma.whale.findUnique({ where: { catalogId: parsed.data.catalogId } });
    if (!sighting || !whale) return reply.code(404).send({ error: 'Not found' });

    await prisma.sightingWhale.upsert({
      where: { sightingId_whaleId: { sightingId: req.params.id, whaleId: whale.id } },
      create: { sightingId: req.params.id, whaleId: whale.id, confidence: parsed.data.confidence },
      update: { confidence: parsed.data.confidence },
    });

    return { ok: true };
  });

  // ---- Photo labeling pipeline (M-Label-1) -------------------------------

  const PendingPhotosQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  app.get(
    '/photos/pending',
    { preHandler: requireAdmin },
    async (req, reply): Promise<LabelablePhotoDTO[] | void> => {
      const parsed = PendingPhotosQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid query' });

      const photos = await prisma.sightingPhoto.findMany({
        where: { done: false },
        orderBy: { sighting: { createdAt: 'desc' } },
        take: parsed.data.limit,
        include: {
          sighting: {
            select: {
              id: true,
              observedAt: true,
              locationName: true,
              observerEmail: true,
            },
          },
          annotations: {
            orderBy: { version: 'desc' },
            take: 1,
            include: { whale: { select: { catalogId: true, name: true } } },
          },
        },
      });

      return photos.map((photo) => ({
        id: photo.id,
        url: photo.url,
        thumbnailUrl: photo.thumbnailUrl,
        orderIndex: photo.orderIndex,
        done: photo.done,
        createdAt: photo.createdAt.toISOString(),
        sighting: {
          id: photo.sighting.id,
          observedAt: photo.sighting.observedAt.toISOString(),
          locationName: photo.sighting.locationName,
          observerEmail: photo.sighting.observerEmail,
        },
        latestAnnotation: photo.annotations[0]
          ? toAnnotationDTO(photo.annotations[0])
          : null,
      }));
    },
  );

  app.get<{ Params: { photoId: string } }>(
    '/photos/:photoId/annotations',
    { preHandler: requireAdmin },
    async (req, reply): Promise<PhotoAnnotationDTO[] | void> => {
      const photo = await prisma.sightingPhoto.findUnique({ where: { id: req.params.photoId } });
      if (!photo) return reply.code(404).send({ error: 'Not found' });

      const annotations = await prisma.photoAnnotation.findMany({
        where: { photoId: req.params.photoId },
        orderBy: { version: 'desc' },
        include: { whale: { select: { catalogId: true, name: true } } },
      });

      return annotations.map(toAnnotationDTO);
    },
  );

  app.post<{ Params: { photoId: string } }>(
    '/photos/:photoId/annotate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = AnnotateBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

      const photo = await prisma.sightingPhoto.findUnique({
        where: { id: req.params.photoId },
      });
      if (!photo) return reply.code(404).send({ error: 'Not found' });

      let whaleId: string | null = null;
      if (parsed.data.whaleCatalogId) {
        const whale = await prisma.whale.findUnique({
          where: { catalogId: parsed.data.whaleCatalogId },
        });
        if (!whale) return reply.code(404).send({ error: 'Whale not found' });
        whaleId = whale.id;
      }

      const latest = await prisma.photoAnnotation.findFirst({
        where: { photoId: req.params.photoId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latest?.version ?? 0) + 1;
      const done = parsed.data.done ?? false;
      const payload = parsed.data.payload ?? {};

      const annotation = await prisma.photoAnnotation.create({
        data: {
          photoId: req.params.photoId,
          version: nextVersion,
          quality: parsed.data.quality,
          payload,
          whaleId,
          confidence: parsed.data.confidence ?? null,
          notes: parsed.data.notes ?? null,
          done,
          labeledById: req.admin!.userId,
        },
        include: { whale: { select: { catalogId: true, name: true } } },
      });

      // Mirror the `done` flag onto the parent photo so the queue query stays
      // a simple `where: { done: false }` lookup.
      if (done !== photo.done) {
        await prisma.sightingPhoto.update({
          where: { id: req.params.photoId },
          data: { done },
        });
      }

      await prisma.auditLog.create({
        data: {
          userId: req.admin!.userId,
          action: 'LABEL_PHOTO',
          entityType: 'sighting_photo',
          entityId: req.params.photoId,
          metadata: {
            version: nextVersion,
            quality: parsed.data.quality,
            whaleCatalogId: parsed.data.whaleCatalogId ?? null,
            confidence: parsed.data.confidence ?? null,
            payload,
            done,
          },
        },
      });

      return reply.code(201).send(toAnnotationDTO(annotation));
    },
  );

  // ---- Identifier reference photos (MiewID V1) ---------------------------

  const ReferencePhotoQuery = z.object({
    side: ReferencePhotoSideEnum.default('UNKNOWN'),
    quality: PhotoQualityEnum.default('USABLE'),
    notes: z.string().max(500).optional(),
    cropX: z.coerce.number().finite().nonnegative().optional(),
    cropY: z.coerce.number().finite().nonnegative().optional(),
    cropWidth: z.coerce.number().finite().positive().optional(),
    cropHeight: z.coerce.number().finite().positive().optional(),
  });

  app.get(
    '/reference-photos',
    { preHandler: requireAdmin },
    async (): Promise<WhaleReferencePhotoDTO[]> => {
      const photos = await prisma.whaleReferencePhoto.findMany({
        orderBy: { createdAt: 'desc' },
        include: { whale: { select: { catalogId: true, name: true } } },
        take: 500,
      });
      return photos.map(toReferencePhotoDTO);
    },
  );

  app.post<{ Params: { catalogId: string } }>(
    '/whales/:catalogId/reference-photos',
    { preHandler: requireAdmin },
    async (req, reply): Promise<WhaleReferencePhotoDTO | void> => {
      const parsed = ReferencePhotoQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid query' });

      const whale = await prisma.whale.findUnique({
        where: { catalogId: req.params.catalogId },
        select: { id: true, catalogId: true, name: true },
      });
      if (!whale) return reply.code(404).send({ error: 'Whale not found' });

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'Multipart file required' });
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
        return reply.code(415).send({ error: `Unsupported content type: ${file.mimetype}` });
      }

      const buffer = await file.toBuffer();
      if (buffer.byteLength === 0) return reply.code(400).send({ error: 'Empty file' });

      let referenceBuffer: Buffer;
      try {
        referenceBuffer = await sharp(buffer)
          .rotate()
          .resize({ width: 1200, withoutEnlargement: true })
          .webp({ quality: 88 })
          .toBuffer();
      } catch (error) {
        req.log.error({ error }, 'sharp failed to process reference photo');
        return reply.code(400).send({ error: 'Photo could not be processed' });
      }

      const storage = getStorageBackend();
      const filename = buildPhotoFilename(file.filename || `${whale.catalogId}.webp`, referenceBuffer)
        .replace(/\.[^./]+$/, '.webp');
      const stored = await storage.put({
        prefix: `reference-photos/${whale.id}`,
        filename,
        contentType: 'image/webp',
        body: referenceBuffer,
      });

      const photo = await prisma.whaleReferencePhoto.create({
        data: {
          whaleId: whale.id,
          storageKey: stored.key,
          url: stored.url,
          side: parsed.data.side,
          quality: parsed.data.quality,
          cropX: parsed.data.cropX ?? null,
          cropY: parsed.data.cropY ?? null,
          cropWidth: parsed.data.cropWidth ?? null,
          cropHeight: parsed.data.cropHeight ?? null,
          notes: parsed.data.notes ?? null,
          embeddingStatus: 'PENDING',
        },
        include: { whale: { select: { catalogId: true, name: true } } },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.admin!.userId,
          action: 'UPLOAD_REFERENCE_PHOTO',
          entityType: 'whale_reference_photo',
          entityId: photo.id,
          metadata: {
            catalogId: whale.catalogId,
            side: parsed.data.side,
            quality: parsed.data.quality,
            storageKey: stored.key,
          },
        },
      });

      return reply.code(201).send(toReferencePhotoDTO(photo));
    },
  );

  const RebuildResponse = z.object({
    ok: z.boolean(),
    indexVersion: z.string(),
    embeddedReferencePhotoIds: z.array(z.string()),
    failedReferencePhotoIds: z.array(z.string()).default([]),
  });

  app.post('/identifier/rebuild-index', { preHandler: requireAdmin }, async (req, reply) => {
    const photos = await prisma.whaleReferencePhoto.findMany({
      where: {
        quality: { not: 'NOT_ORCA' },
      },
      include: { whale: { select: { catalogId: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (photos.length === 0) {
      return reply.code(400).send({ error: 'No reference photos available to index' });
    }

    const serviceUrl = `${env.IDENTIFIER_SERVICE_URL.replace(/\/$/, '')}/rebuild-index`;
    let response: globalThis.Response;
    try {
      response = await fetch(serviceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          references: photos.map((photo) => ({
            referencePhotoId: photo.id,
            catalogId: photo.whale.catalogId,
            name: photo.whale.name,
            url: photo.url,
            side: photo.side,
            quality: photo.quality,
            crop: photo.cropX === null
              ? null
              : {
                  x: photo.cropX,
                  y: photo.cropY,
                  width: photo.cropWidth,
                  height: photo.cropHeight,
                },
          })),
        }),
      });
    } catch (error) {
      req.log.error({ error, serviceUrl }, 'identifier service unavailable');
      return reply.code(503).send({ error: 'Identifier service is not running' });
    }

    if (!response.ok) {
      const text = await response.text();
      req.log.error({ status: response.status, body: text.slice(0, 500) }, 'index rebuild failed');
      return reply.code(502).send({ error: 'Identifier index rebuild failed' });
    }

    const parsed = RebuildResponse.safeParse(await response.json());
    if (!parsed.success) {
      return reply.code(502).send({ error: 'Identifier service returned an invalid response' });
    }

    if (parsed.data.embeddedReferencePhotoIds.length > 0) {
      await prisma.whaleReferencePhoto.updateMany({
        where: { id: { in: parsed.data.embeddedReferencePhotoIds } },
        data: { embeddingStatus: 'EMBEDDED' },
      });
    }
    if (parsed.data.failedReferencePhotoIds.length > 0) {
      await prisma.whaleReferencePhoto.updateMany({
        where: { id: { in: parsed.data.failedReferencePhotoIds } },
        data: { embeddingStatus: 'FAILED' },
      });
    }

    await prisma.auditLog.create({
      data: {
        userId: req.admin!.userId,
        action: 'REBUILD_IDENTIFIER_INDEX',
        entityType: 'identifier_index',
        entityId: parsed.data.indexVersion,
        metadata: {
          embedded: parsed.data.embeddedReferencePhotoIds.length,
          failed: parsed.data.failedReferencePhotoIds.length,
        },
      },
    });

    return parsed.data;
  });
}
