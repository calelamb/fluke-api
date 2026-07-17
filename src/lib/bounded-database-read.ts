import type { Prisma, PrismaClient } from '@prisma/client';
import { abortableRead } from './read-deadline.js';

const MAX_TRANSACTION_WAIT_MS = 1_000;

export interface BoundedReadRouteOptions {
  readonly statementTimeoutMs: number;
}

export async function boundedDatabaseRead<T>(
  client: PrismaClient,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  signal: AbortSignal,
  statementTimeoutMs: number,
): Promise<T> {
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
    throw new Error('statementTimeoutMs must be a positive integer');
  }

  const transaction = client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`;
    return operation(tx);
  }, {
    maxWait: Math.min(statementTimeoutMs, MAX_TRANSACTION_WAIT_MS),
    timeout: statementTimeoutMs,
  });

  return abortableRead(transaction, signal);
}
