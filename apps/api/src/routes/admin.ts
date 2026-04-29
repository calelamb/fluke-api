import type {
  LabelablePhotoDTO,
  PendingSightingDTO,
  PhotoAnnotationDTO,
  PhotoAnnotationPayload,
} from '@fluke/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAdmin } from '../lib/auth.js';

const PhotoQualityEnum = z.enum([
  'USABLE',
  'OCCLUDED',
  'MOTION_BLUR',
  'WRONG_ANGLE',
  'TOO_DISTANT',
  'NOT_ORCA',
]);

const ConfidenceEnum = z.enum(['CONFIRMED', 'LIKELY', 'ML_SUGGESTED']);

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
}
