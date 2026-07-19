import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IsoDateTimeSchema, StableIdSchema } from '../contracts/index.js';
import { prisma } from '../db.js';
import { requireAdmin } from '../lib/auth.js';
import { boundedDatabaseRead } from '../lib/bounded-database-read.js';
import { requireCsrf } from '../lib/csrf.js';
import {
  IdentifierCatalogInventorySchema,
  validateIdentifierCatalogInventory,
} from '../services/local-identification.js';

const SCORE_SEMANTICS = 'uncalibrated_similarity_not_probability';
const RELEASE_MUTATION_LIMIT = 10;
const RELEASE_MUTATION_WINDOW = '1 hour';
const RIGHTS_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export const IdentifierReleasePublicSchema = z.object({
  manifestVersion: StableIdSchema,
  modelVersion: StableIdSchema,
  indexVersion: StableIdSchema,
  scoreSemantics: z.literal(SCORE_SEMANTICS),
  publishedAt: IsoDateTimeSchema,
  suggestionsAcceptedUntil: IsoDateTimeSchema.nullable(),
}).strict();

const RegisterReleaseBodySchema = z.object({
  catalogInventory: IdentifierCatalogInventorySchema,
  indexVersion: StableIdSchema,
  manifestVersion: StableIdSchema,
  modelId: StableIdSchema,
  modelVersion: StableIdSchema,
  publishedAt: IsoDateTimeSchema,
  rightsAttestationDigest: z.string().regex(RIGHTS_DIGEST_PATTERN),
  scoreSemantics: z.literal(SCORE_SEMANTICS),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  suggestionsAcceptedUntil: IsoDateTimeSchema.nullable(),
}).strict();

const ReleaseParamsSchema = z.object({ manifestVersion: StableIdSchema }).strict();

class ReleaseConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Identifier release conflicts with registered history.');
    this.name = 'ReleaseConflictError';
  }
}

interface IdentifierReleaseRouteOptions {
  readonly statementTimeoutMs: number;
}

interface RegisteredReleaseResponse {
  readonly manifestVersion: string;
  readonly status: 'ACTIVE';
}

interface RevokedReleaseResponse {
  readonly manifestVersion: string;
  readonly status: 'REVOKED';
}

function publicRelease(release: {
  readonly indexVersion: string;
  readonly manifestVersion: string;
  readonly modelVersion: string;
  readonly publishedAt: Date;
  readonly scoreSemantics: string;
  readonly suggestionsAcceptedUntil: Date | null;
}) {
  return IdentifierReleasePublicSchema.parse({
    indexVersion: release.indexVersion,
    manifestVersion: release.manifestVersion,
    modelVersion: release.modelVersion,
    publishedAt: release.publishedAt.toISOString(),
    scoreSemantics: release.scoreSemantics,
    suggestionsAcceptedUntil: release.suggestionsAcceptedUntil?.toISOString() ?? null,
  });
}

function requireReleaseAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (request.admin?.role !== 'ADMIN') {
    reply.code(403).send({ error: 'Forbidden' });
  }
}

async function authorizeReleaseMutation(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAdmin(request, reply);
  if (reply.sent) return;
  requireReleaseAdministrator(request, reply);
  if (reply.sent) return;
  await requireCsrf(request, reply);
}

function releaseData(body: z.infer<typeof RegisterReleaseBodySchema>) {
  return {
    catalogInventory: body.catalogInventory as Prisma.InputJsonValue,
    indexVersion: body.indexVersion,
    manifestVersion: body.manifestVersion,
    modelId: body.modelId,
    modelVersion: body.modelVersion,
    publishedAt: new Date(body.publishedAt),
    rightsAttestationDigest: body.rightsAttestationDigest,
    scoreSemantics: body.scoreSemantics,
    sequence: BigInt(body.sequence),
    status: 'ACTIVE' as const,
    suggestionsAcceptedUntil: body.suggestionsAcceptedUntil === null
      ? null
      : new Date(body.suggestionsAcceptedUntil),
  };
}

async function registerRelease(
  body: z.infer<typeof RegisterReleaseBodySchema>,
  userId: string,
): Promise<RegisteredReleaseResponse> {
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.identifierRelease.findUnique({
      select: { manifestVersion: true },
      where: { manifestVersion: body.manifestVersion },
    });
    if (existing !== null) throw new ReleaseConflictError();

    const latest = await transaction.identifierRelease.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    if (latest !== null && BigInt(body.sequence) <= latest.sequence) {
      throw new ReleaseConflictError();
    }

    await validateIdentifierCatalogInventory(
      transaction,
      body.catalogInventory as Prisma.JsonValue,
    );
    await transaction.identifierRelease.updateMany({
      data: { status: 'ACCEPTED' },
      where: { status: 'ACTIVE' },
    });
    const created = await transaction.identifierRelease.create({
      data: releaseData(body),
      select: { manifestVersion: true, status: true },
    });
    await transaction.auditLog.create({
      data: {
        action: 'IDENTIFIER_RELEASE_ACCEPTED',
        entityId: created.manifestVersion,
        entityType: 'identifier_release',
        metadata: {
          rightsAttestationDigest: body.rightsAttestationDigest,
          sequence: body.sequence,
        },
        userId,
      },
    });
    return Object.freeze({ manifestVersion: created.manifestVersion, status: 'ACTIVE' });
  }, { isolationLevel: 'Serializable' });
}

async function revokeRelease(
  manifestVersion: string,
  userId: string,
): Promise<RevokedReleaseResponse | null> {
  return prisma.$transaction(async (transaction) => {
    const release = await transaction.identifierRelease.findUnique({
      select: { manifestVersion: true, status: true },
      where: { manifestVersion },
    });
    if (release === null) return null;
    if (release.status === 'REVOKED') {
      return Object.freeze({ manifestVersion, status: 'REVOKED' as const });
    }
    await transaction.identifierRelease.update({
      data: { revokedAt: new Date(), status: 'REVOKED' },
      where: { manifestVersion },
    });
    await transaction.auditLog.create({
      data: {
        action: 'IDENTIFIER_RELEASE_REVOKED',
        entityId: manifestVersion,
        entityType: 'identifier_release',
        userId,
      },
    });
    return Object.freeze({ manifestVersion, status: 'REVOKED' as const });
  }, { isolationLevel: 'Serializable' });
}

const identifierReleaseRoutes: FastifyPluginAsync<IdentifierReleaseRouteOptions> = async (
  fastify,
  options,
) => {
  fastify.get('/identifier/releases/current', async (request, reply) => {
    const release = await boundedDatabaseRead(prisma, (transaction) => (
      transaction.identifierRelease.findFirst({
        select: {
          indexVersion: true,
          manifestVersion: true,
          modelVersion: true,
          publishedAt: true,
          scoreSemantics: true,
          suggestionsAcceptedUntil: true,
        },
        where: { status: 'ACTIVE' },
      })
    ), request.signal, options.statementTimeoutMs);
    if (release === null) return reply.code(404).send({ error: 'Not found' });
    return publicRelease(release);
  });
};

export const identifierReleaseAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const mutationOptions = {
    config: {
      rateLimit: { max: RELEASE_MUTATION_LIMIT, timeWindow: RELEASE_MUTATION_WINDOW },
    },
    preHandler: authorizeReleaseMutation,
  } as const;

  fastify.post('/accept', mutationOptions, async (request, reply) => {
    const parsed = RegisterReleaseBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid release' });
    const registered = await registerRelease(parsed.data, request.admin!.userId);
    return reply.code(201).send(registered);
  });

  fastify.post('/:manifestVersion/revoke', mutationOptions, async (request, reply) => {
    const params = ReleaseParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid release' });
    const revoked = await revokeRelease(params.data.manifestVersion, request.admin!.userId);
    if (revoked === null) return reply.code(404).send({ error: 'Not found' });
    return revoked;
  });
};

export default identifierReleaseRoutes;
