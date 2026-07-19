import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StableIdSchema } from '../contracts/index.js';
import { prisma } from '../db.js';
import { requireAdmin } from '../lib/auth.js';
import { requireCsrf } from '../lib/csrf.js';
import { isPrismaReplayRace } from '../lib/idempotency.js';

const SUGGESTION_MUTATION_LIMIT = 60;
const SUGGESTION_MUTATION_WINDOW = '1 hour';
const SERIALIZABLE_ATTEMPTS = 3;
const MUTATION_MAX_WAIT_MS = 1_000;
const MUTATION_TIMEOUT_MS = 5_000;
const MUTATION_TRANSACTION_OPTIONS = Object.freeze({
  isolationLevel: 'Serializable' as const,
  maxWait: MUTATION_MAX_WAIT_MS,
  timeout: MUTATION_TIMEOUT_MS,
});
const SuggestionParamsSchema = z.object({ id: StableIdSchema }).strict();
type Decision = 'ACCEPTED' | 'REJECTED';

class SuggestionConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Suggestion already has a different terminal decision.');
    this.name = 'SuggestionConflictError';
  }
}

class SerializableDecisionRaceError extends Error {
  readonly code = 'P2034';

  constructor() {
    super('Suggestion decision lost a serializable race.');
    this.name = 'SerializableDecisionRaceError';
  }
}

class MutationDeadlineError extends Error {
  readonly statusCode = 503;

  constructor() {
    super('Mutation deadline exceeded.');
    this.name = 'MutationDeadlineError';
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
  reader: Pick<Prisma.TransactionClient, 'sightingIdentificationSuggestion'>,
  id: string,
) {
  return reader.sightingIdentificationSuggestion.findUnique({
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new MutationDeadlineError();
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
  signal: AbortSignal,
): Promise<SuggestionDecisionResponse | null> {
  for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await decideSuggestionAttempt(id, decision, userId);
    } catch (error: unknown) {
      if (!isPrismaReplayRace(error)) throw error;
      throwIfAborted(signal);
      const winner = await findSuggestion(prisma, id);
      if (winner !== null && winner.status !== 'PENDING') {
        return terminalResponse(winner, decision);
      }
      if (attempt === SERIALIZABLE_ATTEMPTS) throw error;
    }
  }
  throw new Error('Serializable suggestion decision retry exhausted');
}

async function decideSuggestionAttempt(
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
    if (updated.count !== 1) throw new SerializableDecisionRaceError();
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
  }, MUTATION_TRANSACTION_OPTIONS);
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
      const result = await decideSuggestion(
        params.data.id, decision, request.admin!.userId, request.signal,
      );
      if (result === null) return reply.code(404).send({ error: 'Not found' });
      return result;
    });
  }
};

export default identificationSuggestionRoutes;
