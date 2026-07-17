import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresJobLeaseStore } from '../../src/jobs/postgres-job-store.js';

const postgresEnabled = process.env.RUN_POSTGRES_INTEGRATION === 'true';
const jobName = `integration-job-${randomUUID()}`;

describe.runIf(postgresEnabled)('job operations against PostgreSQL', () => {
  let prisma: typeof import('../../src/db.js')['prisma'];
  let store: PostgresJobLeaseStore;

  beforeAll(async () => {
    ({ prisma } = await import('../../src/db.js'));
    store = new PostgresJobLeaseStore(prisma, 60_000);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.jobLease.deleteMany({ where: { jobName } });
      await prisma.$disconnect();
    }
  });

  it('admits only one concurrent owner and fences stale mutations', async () => {
    const [first, contender] = await Promise.all([
      store.acquire(jobName, randomUUID(), randomUUID()),
      store.acquire(jobName, randomUUID(), randomUUID()),
    ]);
    const acquired = first ?? contender;

    expect(acquired).not.toBeNull();
    expect([first, contender].filter(Boolean)).toHaveLength(1);
    if (!acquired) return;

    await expect(store.runFenced(acquired, async (transaction) => {
      const [result] = await transaction.$queryRaw<Array<{ value: number }>>`SELECT 1 AS value`;
      return result?.value;
    })).resolves.toBe(1);

    await store.release(acquired);
    await expect(store.runFenced(acquired, async () => 'stale write')).rejects.toThrow(
      'lease is no longer current',
    );
  });

  it('enforces append-only job audit rows in PostgreSQL', async () => {
    const runId = randomUUID();
    const lease = await store.acquire(jobName, runId, randomUUID());
    expect(lease).not.toBeNull();
    if (!lease) return;

    await expect(prisma.jobRunEvent.updateMany({
      data: { errorCode: 'tampered' },
      where: { runId },
    })).rejects.toThrow('job_run_events are append-only');
    await store.release(lease);
  });

  it('cannot append stale success after another owner reclaims the job', async () => {
    const staleRunId = randomUUID();
    const stale = await store.acquire(jobName, staleRunId, randomUUID());
    expect(stale).not.toBeNull();
    if (!stale) return;

    await store.release(stale);
    const replacement = await store.acquire(jobName, randomUUID(), randomUUID());
    expect(replacement).not.toBeNull();
    if (!replacement) return;

    await expect(store.finalizeSuccess(stale, { processed: 1 })).resolves.toBe(false);
    await expect(prisma.jobRunEvent.count({
      where: { event: 'SUCCEEDED', runId: staleRunId },
    })).resolves.toBe(0);
    await store.release(replacement);
  });
});
