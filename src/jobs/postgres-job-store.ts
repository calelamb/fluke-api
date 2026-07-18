import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  JobEvent,
  JobLease,
  JobLeaseStore,
  JobSummary,
} from './job-runner.js';

const DEFAULT_LEASE_MS = 20 * 60 * 1_000;
const TRANSACTION_TIMEOUT_MS = 15_000;

interface FenceRow {
  readonly fence: bigint;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function eventData(event: JobEvent): Prisma.JobRunEventCreateInput {
  return {
    errorCode: event.errorCode,
    event: event.event,
    fence: event.fence,
    jobName: event.jobName,
    runId: event.runId,
    summary: event.summary as Prisma.InputJsonValue | undefined,
  };
}

export class PostgresJobLeaseStore implements JobLeaseStore {
  readonly #client: PrismaClient;
  readonly #leaseSeconds: number;

  constructor(client: PrismaClient, leaseMs = DEFAULT_LEASE_MS) {
    this.#client = client;
    this.#leaseSeconds = Math.ceil(positiveInteger(leaseMs, 'leaseMs') / 1_000);
  }

  async acquire(
    jobName: string,
    runId: string,
    ownerToken: string,
  ): Promise<JobLease | null> {
    return this.#client.$transaction(async (transaction) => {
      const [row] = await transaction.$queryRaw<FenceRow[]>`
        INSERT INTO "job_leases" (
          "job_name", "run_id", "owner_token", "fence",
          "acquired_at", "heartbeat_at", "lease_expires_at"
        )
        VALUES (
          ${jobName}, ${runId}, ${ownerToken}, 1,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + make_interval(secs => ${this.#leaseSeconds})
        )
        ON CONFLICT ("job_name") DO UPDATE SET
          "run_id" = EXCLUDED."run_id",
          "owner_token" = EXCLUDED."owner_token",
          "fence" = "job_leases"."fence" + 1,
          "acquired_at" = CURRENT_TIMESTAMP,
          "heartbeat_at" = CURRENT_TIMESTAMP,
          "lease_expires_at" = EXCLUDED."lease_expires_at"
        WHERE "job_leases"."lease_expires_at" <= CURRENT_TIMESTAMP
        RETURNING "fence"
      `;
      if (!row) return null;

      const lease = Object.freeze({ fence: row.fence, jobName, ownerToken, runId });
      await transaction.jobRunEvent.create({ data: eventData({ ...lease, event: 'STARTED' }) });
      return lease;
    }, { timeout: TRANSACTION_TIMEOUT_MS });
  }

  async append(event: JobEvent): Promise<void> {
    await this.#client.jobRunEvent.create({ data: eventData(event) });
  }

  async finalizeSuccess(lease: JobLease, summary: JobSummary): Promise<boolean> {
    return this.#client.$transaction(async (transaction) => {
      const [row] = await transaction.$queryRaw<Array<{ retained: boolean }>>`
        SELECT true AS "retained"
        FROM "job_leases"
        WHERE "job_name" = ${lease.jobName}
          AND "run_id" = ${lease.runId}
          AND "owner_token" = ${lease.ownerToken}
          AND "fence" = ${lease.fence}
          AND "lease_expires_at" > CURRENT_TIMESTAMP
        FOR UPDATE
      `;
      if (!row?.retained) return false;
      await transaction.jobRunEvent.create({
        data: eventData({ ...lease, event: 'SUCCEEDED', summary }),
      });
      return true;
    }, { timeout: TRANSACTION_TIMEOUT_MS });
  }

  async heartbeat(lease: JobLease): Promise<boolean> {
    const changed = await this.#client.$executeRaw`
      UPDATE "job_leases"
      SET
        "heartbeat_at" = CURRENT_TIMESTAMP,
        "lease_expires_at" = CURRENT_TIMESTAMP + make_interval(secs => ${this.#leaseSeconds})
      WHERE "job_name" = ${lease.jobName}
        AND "run_id" = ${lease.runId}
        AND "owner_token" = ${lease.ownerToken}
        AND "fence" = ${lease.fence}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
    `;
    return changed === 1;
  }

  async release(lease: JobLease): Promise<void> {
    await this.#client.$executeRaw`
      UPDATE "job_leases"
      SET "lease_expires_at" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond'
      WHERE "job_name" = ${lease.jobName}
        AND "run_id" = ${lease.runId}
        AND "owner_token" = ${lease.ownerToken}
        AND "fence" = ${lease.fence}
    `;
  }

  async runFenced<T>(
    lease: JobLease,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.#client.$transaction(async (transaction) => {
      const [row] = await transaction.$queryRaw<Array<{ retained: boolean }>>`
        SELECT true AS "retained"
        FROM "job_leases"
        WHERE "job_name" = ${lease.jobName}
          AND "run_id" = ${lease.runId}
          AND "owner_token" = ${lease.ownerToken}
          AND "fence" = ${lease.fence}
          AND "lease_expires_at" > CURRENT_TIMESTAMP
        FOR UPDATE
      `;
      if (!row?.retained) {
        throw new Error(`Job ${lease.jobName} lease is no longer current`);
      }
      return operation(transaction);
    }, { timeout: TRANSACTION_TIMEOUT_MS });
  }
}
