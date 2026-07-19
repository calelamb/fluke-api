import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StableIdSchema } from '../contracts/index.js';
import { prisma } from '../db.js';
import { requireAdmin } from '../lib/auth.js';
import { requireCsrf } from '../lib/csrf.js';

const SUGGESTION_MUTATION_LIMIT = 60;
const SUGGESTION_MUTATION_WINDOW = '1 hour';
const SuggestionParamsSchema = z.object({ id: StableIdSchema }).strict();
type Decision = 'ACCEPTED' | 'REJECTED';

class SuggestionConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Suggestion already has a different terminal decision.');
    this.name = 'SuggestionConflictError';
  }
}

interface SuggestionRecord {
  readonly id: string;
  readonly reviewedAt: Date | null;
  readonly reviewedById: string | null;
  readonly sightingId: string;
  readonly status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'INVALIDATED';
  readonly whaleId: string;
}

interface SuggestionDecisionResponse {
  readonly id: string;
  readonly reviewedAt: string | null;
  readonly reviewedById: string | null;
  readonly status: Decision;
}

function terminalResponse(record: SuggestionRecord, decision: Decision): SuggestionDecisionResponse {
  if (record.status !== decision) throw new SuggestionConflictError();
  return Object.freeze({
    id: record.id,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    reviewedById: record.reviewedById,
    status: decision,
  });
}

function findSuggestion(
  transaction: Prisma.TransactionClient,
  id: string,
) {
  return transaction.sightingIdentificationSuggestion.findUnique({
    select: {
      id: true,
      reviewedAt: true,
      reviewedById: true,
      sightingId: true,
      status: true,
      whaleId: true,
    },
    where: { id },
  });
}

async function authorizeSuggestionMutation(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAdmin(request, reply);
  if (reply.sent) return;
  await requireCsrf(request, reply);
}

async function decideSuggestion(
  id: string,
  decision: Decision,
  userId: string,
): Promise<SuggestionDecisionResponse | null> {
  return prisma.$transaction(async (transaction) => {
    const existing = await findSuggestion(transaction, id);
    if (existing === null) return null;
    if (existing.status !== 'PENDING') return terminalResponse(existing, decision);

    const reviewedAt = new Date();
    const updated = await transaction.sightingIdentificationSuggestion.updateMany({
      data: { reviewedAt, reviewedById: userId, status: decision },
      where: { id, status: 'PENDING' },
    });
    if (updated.count !== 1) {
      const winner = await findSuggestion(transaction, id);
      if (winner === null) return null;
      return terminalResponse(winner, decision);
    }
    if (decision === 'ACCEPTED') {
      await transaction.sightingWhale.createMany({
        data: [{
          confidence: 'ML_SUGGESTED',
          sightingId: existing.sightingId,
          whaleId: existing.whaleId,
        }],
        skipDuplicates: true,
      });
    }
    await transaction.auditLog.create({
      data: {
        action: `IDENTIFICATION_SUGGESTION_${decision}`,
        entityId: id,
        entityType: 'sighting_identification_suggestion',
        metadata: { sightingId: existing.sightingId, whaleId: existing.whaleId },
        userId,
      },
    });
    return Object.freeze({
      id,
      reviewedAt: reviewedAt.toISOString(),
      reviewedById: userId,
      status: decision,
    });
  }, { isolationLevel: 'Serializable' });
}

const identificationSuggestionRoutes: FastifyPluginAsync = async (fastify) => {
  const mutationOptions = {
    config: {
      rateLimit: { max: SUGGESTION_MUTATION_LIMIT, timeWindow: SUGGESTION_MUTATION_WINDOW },
    },
    preHandler: authorizeSuggestionMutation,
  } as const;

  for (const [path, decision] of [
    ['/accept', 'ACCEPTED'],
    ['/reject', 'REJECTED'],
  ] as const) {
    fastify.post(`/:id${path}`, mutationOptions, async (request, reply) => {
      const params = SuggestionParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'Invalid suggestion' });
      const result = await decideSuggestion(params.data.id, decision, request.admin!.userId);
      if (result === null) return reply.code(404).send({ error: 'Not found' });
      return result;
    });
  }
};

export default identificationSuggestionRoutes;
