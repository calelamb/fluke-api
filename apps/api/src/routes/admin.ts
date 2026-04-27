import type { PendingSightingDTO } from '@fluke/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAdmin } from '../lib/auth.js';

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
      include: { whales: { include: { whale: true } } },
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
}
