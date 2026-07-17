import type { FastifyPluginAsync } from 'fastify';
import {
  SubmitSightingPayloadSchema,
  type SubmitSightingResponse,
} from '../contracts/index.js';
import { prisma } from '../db.js';

/**
 * Photo-upload tokens are scoped to a specific sighting and to the
 * photo-upload action. They allow the offline submission queue to replay
 * photo POSTs after the public 30-minute upload window has closed without
 * exposing admin-level access. The 24-hour TTL is generous enough to cover a
 * ferry crossing and overnight without service.
 */
const PHOTO_UPLOAD_TOKEN_TTL = '24h';
export const PHOTO_UPLOAD_TOKEN_TYPE = 'photo-upload';

export interface PhotoUploadTokenPayload {
  readonly sightingId: string;
  readonly type: typeof PHOTO_UPLOAD_TOKEN_TYPE;
}

const notImplemented = Object.freeze({
  error: 'Not implemented; reserved for future user-account work',
});

const sightingSubmissionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/sightings',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const parsed = SubmitSightingPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid sighting submission' });
      }

      const body = parsed.data;
      const sighting = await prisma.sighting.create({
        data: {
          observedAt: new Date(body.observedAt),
          latitude: body.latitude,
          longitude: body.longitude,
          locationName: body.locationName,
          ecotypeGuess: body.ecotypeGuess,
          groupSize: body.groupSize,
          behaviorNotes: body.behaviorNotes,
          observerName: body.observerName,
          observerEmail: body.observerEmail,
          status: 'PENDING',
        },
      });

      const tokenPayload: PhotoUploadTokenPayload = {
        sightingId: sighting.id,
        type: PHOTO_UPLOAD_TOKEN_TYPE,
      };
      const photoUploadToken = fastify.jwt.sign(tokenPayload, {
        expiresIn: PHOTO_UPLOAD_TOKEN_TTL,
      });

      const responseBody: SubmitSightingResponse = {
        ok: true,
        id: sighting.id,
        photoUploadToken,
      };
      return reply.code(201).send(responseBody);
    },
  );
  fastify.put('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
  fastify.patch('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
  fastify.delete('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
};

export default sightingSubmissionRoutes;
