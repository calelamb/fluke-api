import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PostgresJobLeaseStore } from '../../src/jobs/postgres-job-store.js';
import type { JobLease } from '../../src/jobs/job-runner.js';

const lease: JobLease = Object.freeze({
  fence: 4n,
  jobName: 'acartia-ingest',
  ownerToken: 'owner',
  runId: 'run',
});

function clientFromTransaction(transaction: object): PrismaClient {
  return {
    $transaction: vi.fn(async (operation: (tx: object) => Promise<unknown>) => operation(transaction)),
  } as unknown as PrismaClient;
}

describe('PostgresJobLeaseStore', () => {
  it('acquires a lease and appends STARTED in the same transaction', async () => {
    const transaction = {
      $queryRaw: vi.fn(async () => [{ fence: 4n }]),
      jobRunEvent: { create: vi.fn(async () => undefined) },
    };
    const store = new PostgresJobLeaseStore(clientFromTransaction(transaction));

    await expect(store.acquire(lease.jobName, lease.runId, lease.ownerToken)).resolves.toEqual(lease);
    expect(transaction.jobRunEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'STARTED', fence: 4n, runId: 'run' }),
    });
  });

  it('returns null when a live lease prevents acquisition', async () => {
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      jobRunEvent: { create: vi.fn(async () => undefined) },
    };
    const store = new PostgresJobLeaseStore(clientFromTransaction(transaction));

    await expect(store.acquire(lease.jobName, lease.runId, lease.ownerToken)).resolves.toBeNull();
    expect(transaction.jobRunEvent.create).not.toHaveBeenCalled();
  });

  it('fences each mutation transaction before invoking its operation', async () => {
    const transaction = {
      $queryRaw: vi.fn(async () => [{ retained: true }]),
    };
    const store = new PostgresJobLeaseStore(clientFromTransaction(transaction));
    const operation = vi.fn(async (_tx: Prisma.TransactionClient) => 'written');

    await expect(store.runFenced(lease, operation)).resolves.toBe('written');
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
  });

  it('rejects a stale worker before invoking its mutation', async () => {
    const transaction = {
      $queryRaw: vi.fn(async () => [{ retained: false }]),
    };
    const store = new PostgresJobLeaseStore(clientFromTransaction(transaction));
    const operation = vi.fn(async () => 'written');

    await expect(store.runFenced(lease, operation)).rejects.toThrow('lease is no longer current');
    expect(operation).not.toHaveBeenCalled();
  });

  it('verifies the exact lease and appends success in one transaction', async () => {
    const transaction = {
      $queryRaw: vi.fn(async () => [{ retained: true }]),
      jobRunEvent: { create: vi.fn(async () => undefined) },
    };
    const store = new PostgresJobLeaseStore(clientFromTransaction(transaction));

    await expect(store.finalizeSuccess(lease, { processed: 2 })).resolves.toBe(true);
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.jobRunEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: 'SUCCEEDED',
        fence: 4n,
        runId: 'run',
        summary: { processed: 2 },
      }),
    });
  });

  it('does not append success after the exact lease is lost', async () => {
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      jobRunEvent: { create: vi.fn(async () => undefined) },
    };
    const store = new PostgresJobLeaseStore(clientFromTransaction(transaction));

    await expect(store.finalizeSuccess(lease, { processed: 2 })).resolves.toBe(false);
    expect(transaction.jobRunEvent.create).not.toHaveBeenCalled();
  });

  it('expires a released lease without deleting its monotonic fence', async () => {
    const executeRaw = vi.fn(async () => 1);
    const client = { $executeRaw: executeRaw } as unknown as PrismaClient;
    const store = new PostgresJobLeaseStore(client);

    await store.release(lease);

    expect(executeRaw).toHaveBeenCalledOnce();
    expect(client).not.toHaveProperty('jobLease.deleteMany');
  });
});
