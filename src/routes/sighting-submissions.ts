import type { FastifyPluginAsync } from 'fastify';
import {
  SubmitSightingPayloadSchema,
  type SubmitSightingResponse,
} from '../contracts/index.js';
import { prisma } from '../db.js';
import { requireCsrf } from '../lib/csrf.js';
import {
  buildSubmissionHashes,
  IdempotencyConflictError,
  isPrismaReplayRace,
} from '../lib/idempotency.js';
import { resolveOptionalObserver, type ObserverPrincipal } from '../lib/observer-auth.js';

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
  readonly clientSubmissionId: string;
  readonly sightingId: string;
  readonly type: typeof PHOTO_UPLOAD_TOKEN_TYPE;
}

const notImplemented = Object.freeze({
  error: 'Not implemented; reserved for future user-account work',
});

interface ReplayRecord {
  readonly requestHash: string;
  readonly sighting: { readonly id: string };
}

interface SubmissionResult {
  readonly created: boolean;
  readonly sighting: { readonly id: string };
}

const SERIALIZABLE_ATTEMPTS = 3;

function validateHeaderIdempotencyKey(
  header: string | readonly string[] | undefined,
  clientSubmissionId: string,
): void {
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined && value !== clientSubmissionId) {
    throw new IdempotencyConflictError();
  }
}

function resolveReplay(record: ReplayRecord, requestHash: string): SubmissionResult {
  if (record.requestHash !== requestHash) throw new IdempotencyConflictError();
  return Object.freeze({ created: false, sighting: record.sighting });
}

function sightingData(
  body: ReturnType<typeof SubmitSightingPayloadSchema.parse>,
  observer: ObserverPrincipal | null,
) {
  return {
    behaviorNotes: body.behaviorNotes,
    ecotypeGuess: body.ecotypeGuess,
    groupSize: body.groupSize,
    latitude: body.latitude,
    locationName: body.locationName,
    longitude: body.longitude,
    observedAt: new Date(body.observedAt),
    observerEmail: observer?.email ?? body.observerEmail,
    observerName: observer?.displayName ?? body.observerName,
    observerUserId: observer?.id,
    status: 'PENDING' as const,
  };
}

async function createOrReplaySubmission(
  body: ReturnType<typeof SubmitSightingPayloadSchema.parse>,
  observer: ObserverPrincipal | null,
): Promise<SubmissionResult> {
  const hashes = buildSubmissionHashes(body, observer);
  for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (transaction) => {
        const existing = await transaction.submissionIdempotency.findUnique({
          where: { keyHash: hashes.keyHash },
          select: { requestHash: true, sighting: { select: { id: true } } },
        });
        if (existing !== null) return resolveReplay(existing, hashes.requestHash);
        const sighting = await transaction.sighting.create({ data: sightingData(body, observer) });
        await transaction.submissionIdempotency.create({
          data: {
            keyHash: hashes.keyHash,
            requestHash: hashes.requestHash,
            sightingId: sighting.id,
            userId: observer?.id,
          },
        });
        return Object.freeze({ created: true, sighting: { id: sighting.id } });
      }, { isolationLevel: 'Serializable' });
    } catch (error: unknown) {
      if (!isPrismaReplayRace(error)) throw error;
      const winner = await prisma.submissionIdempotency.findUnique({
        where: { keyHash: hashes.keyHash },
        select: { requestHash: true, sighting: { select: { id: true } } },
      });
      if (winner !== null) return resolveReplay(winner, hashes.requestHash);
      if (attempt === SERIALIZABLE_ATTEMPTS) throw error;
    }
  }
  throw new Error('Serializable submission retry exhausted');
}

function issuePhotoUploadToken(
  fastify: Parameters<FastifyPluginAsync>[0],
  clientSubmissionId: string,
  sightingId: string,
): string {
  const tokenPayload: PhotoUploadTokenPayload = {
    clientSubmissionId,
    sightingId,
    type: PHOTO_UPLOAD_TOKEN_TYPE,
  };
  return fastify.jwt.sign(tokenPayload, { expiresIn: PHOTO_UPLOAD_TOKEN_TTL });
}

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
      validateHeaderIdempotencyKey(request.headers['idempotency-key'], body.clientSubmissionId);
      const observer = await resolveOptionalObserver(request, reply);
      if (observer !== null) await requireCsrf(request, reply);
      const result = await createOrReplaySubmission(body, observer);
      const photoUploadToken = issuePhotoUploadToken(
        fastify, body.clientSubmissionId, result.sighting.id,
      );

      const responseBody: SubmitSightingResponse = {
        ok: true,
        id: result.sighting.id,
        photoUploadToken,
      };
      return reply.code(result.created ? 201 : 200).send(responseBody);
    },
  );
  fastify.put('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
  fastify.patch('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
  fastify.delete('/sightings/:id', async (_request, reply) => reply.code(501).send(notImplemented));
};

export default sightingSubmissionRoutes;
