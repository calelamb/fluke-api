import { describe, expect, it } from 'vitest';
import {
  JOB_EXIT,
  runLockedJob,
  type JobEvent,
  type JobLease,
  type JobLeaseStore,
} from '../../src/jobs/job-runner.js';

class MemoryLeaseStore implements JobLeaseStore {
  readonly events: JobEvent[] = [];
  private active: JobLease | null = null;
  private nextFence = 1n;

  async acquire(jobName: string, runId: string, ownerToken: string): Promise<JobLease | null> {
    if (this.active) return null;
    this.active = { fence: this.nextFence, jobName, ownerToken, runId };
    this.nextFence += 1n;
    this.events.push({ ...this.active, event: 'STARTED' });
    return this.active;
  }

  async append(event: JobEvent): Promise<void> {
    this.events.push(event);
  }

  async heartbeat(lease: JobLease): Promise<boolean> {
    return this.active?.ownerToken === lease.ownerToken;
  }

  async release(lease: JobLease): Promise<void> {
    if (this.active?.ownerToken === lease.ownerToken) this.active = null;
  }

  loseLease(): void {
    if (this.active) this.active = { ...this.active, ownerToken: 'replacement' };
  }
}

describe('runLockedJob', () => {
  it('records immutable start and success events', async () => {
    const store = new MemoryLeaseStore();

    const result = await runLockedJob({
      jobName: 'acartia-ingest',
      ownerToken: 'owner-a',
      runId: 'run-a',
      store,
      work: async () => ({ processed: 2 }),
    });

    expect(result).toEqual({ exitCode: JOB_EXIT.SUCCESS, summary: { processed: 2 } });
    expect(store.events.map((event) => event.event)).toEqual(['STARTED', 'SUCCEEDED']);
  });

  it('returns a lock exit without invoking a second worker', async () => {
    const store = new MemoryLeaseStore();
    await store.acquire('acartia-ingest', 'existing', 'existing-owner');
    let invoked = false;

    const result = await runLockedJob({
      jobName: 'acartia-ingest',
      ownerToken: 'owner-b',
      runId: 'run-b',
      store,
      work: async () => {
        invoked = true;
        return {};
      },
    });

    expect(result.exitCode).toBe(JOB_EXIT.LOCKED);
    expect(invoked).toBe(false);
    expect(store.events.at(-1)?.event).toBe('SKIPPED_LOCKED');
  });

  it('stores a safe failure code without persisting raw error text', async () => {
    const store = new MemoryLeaseStore();

    const result = await runLockedJob({
      jobName: 'gbif-ingest',
      ownerToken: 'owner-c',
      runId: 'run-c',
      store,
      work: async () => {
        throw new Error('postgresql://user:secret@internal/fluke');
      },
    });

    expect(result.exitCode).toBe(JOB_EXIT.FAILURE);
    expect(store.events.at(-1)).toMatchObject({ event: 'FAILED', errorCode: 'JOB_FAILED' });
    expect(
      JSON.stringify(store.events.map(({ errorCode, event }) => ({ errorCode, event }))),
    ).not.toContain('secret');
  });

  it('aborts and records lease loss when a heartbeat loses ownership', async () => {
    const store = new MemoryLeaseStore();
    let tick: (() => void) | undefined;
    const timers = {
      setInterval: (handler: () => void) => {
        tick = handler;
        return setInterval(() => undefined, 60_000);
      },
      clearInterval,
    };

    const result = await runLockedJob({
      heartbeatMs: 1,
      jobName: 'prediction-compute',
      ownerToken: 'owner-d',
      runId: 'run-d',
      store,
      timers,
      work: async (signal) => {
        store.loseLease();
        tick?.();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        throw signal.reason;
      },
    });

    expect(result.exitCode).toBe(JOB_EXIT.LEASE_LOST);
    expect(store.events.at(-1)?.event).toBe('LEASE_LOST');
  });

  it('aborts work at the configured deadline and records a safe timeout code', async () => {
    const store = new MemoryLeaseStore();

    const result = await runLockedJob({
      jobName: 'gbif-ingest',
      ownerToken: 'owner-timeout',
      runId: 'run-timeout',
      store,
      timeoutMs: 5,
      work: async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        throw signal.reason;
      },
    });

    expect(result.exitCode).toBe(JOB_EXIT.FAILURE);
    expect(store.events.at(-1)).toMatchObject({
      errorCode: 'JOB_TIMEOUT',
      event: 'FAILED',
    });
  });

  it('rechecks lease ownership before recording success', async () => {
    const store = new MemoryLeaseStore();

    const result = await runLockedJob({
      jobName: 'prediction-compute',
      store,
      work: async () => {
        store.loseLease();
        return { processed: 1 };
      },
    });

    expect(result.exitCode).toBe(JOB_EXIT.LEASE_LOST);
    expect(store.events.at(-1)).toMatchObject({
      errorCode: 'LEASE_LOST',
      event: 'LEASE_LOST',
    });
  });
});
