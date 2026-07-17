import { randomUUID } from 'node:crypto';

export const JOB_EXIT = Object.freeze({
  SUCCESS: 0,
  FAILURE: 70,
  LEASE_LOST: 70,
  LOCKED: 75,
  CONFIG: 78,
} as const);

export type JobEventType =
  | 'STARTED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED_LOCKED'
  | 'LEASE_LOST';

export type JobSummary = Readonly<Record<string, string | number | boolean | null>>;

export interface JobLease {
  readonly fence: bigint;
  readonly jobName: string;
  readonly ownerToken: string;
  readonly runId: string;
}

export interface JobEvent extends JobLease {
  readonly event: JobEventType;
  readonly errorCode?: string;
  readonly summary?: JobSummary;
}

export interface JobLeaseStore {
  acquire(jobName: string, runId: string, ownerToken: string): Promise<JobLease | null>;
  append(event: JobEvent): Promise<void>;
  heartbeat(lease: JobLease): Promise<boolean>;
  release(lease: JobLease): Promise<void>;
}

interface JobTimers {
  readonly clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  readonly setInterval: (
    handler: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setInterval>;
}

export interface RunLockedJobOptions {
  readonly heartbeatMs?: number;
  readonly jobName: string;
  readonly ownerToken?: string;
  readonly runId?: string;
  readonly store: JobLeaseStore;
  readonly timers?: JobTimers;
  readonly timeoutMs?: number;
  readonly work: (signal: AbortSignal, lease: JobLease) => Promise<JobSummary>;
}

export interface JobRunResult {
  readonly exitCode: number;
  readonly summary?: JobSummary;
}

class LeaseLostError extends Error {
  constructor() {
    super('Scheduled job lease was lost');
    this.name = 'LeaseLostError';
  }
}

class JobTimeoutError extends Error {
  constructor() {
    super('Scheduled job exceeded its deadline');
    this.name = 'JobTimeoutError';
  }
}

const systemTimers: JobTimers = { clearInterval, setInterval };

function eventFor(
  lease: JobLease,
  event: JobEventType,
  details: Pick<JobEvent, 'errorCode' | 'summary'> = {},
): JobEvent {
  return Object.freeze({ ...lease, event, ...details });
}

export async function runLockedJob(
  options: RunLockedJobOptions,
): Promise<JobRunResult> {
  const runId = options.runId ?? randomUUID();
  const ownerToken = options.ownerToken ?? randomUUID();
  const lease = await options.store.acquire(options.jobName, runId, ownerToken);
  if (!lease) {
    await options.store.append({
      event: 'SKIPPED_LOCKED',
      fence: 0n,
      jobName: options.jobName,
      ownerToken,
      runId,
    });
    return { exitCode: JOB_EXIT.LOCKED };
  }

  const controller = new AbortController();
  const timers = options.timers ?? systemTimers;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const heartbeat = timers.setInterval(() => {
    void options.store.heartbeat(lease).then(
      (retained) => {
        if (!retained && !controller.signal.aborted) {
          controller.abort(new LeaseLostError());
        }
      },
      () => {
        if (!controller.signal.aborted) controller.abort(new LeaseLostError());
      },
    );
  }, heartbeatMs);
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    timers.clearInterval(heartbeat);
    await options.store.release(lease);
    throw new Error('timeoutMs must be a positive integer');
  }
  const deadline = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new JobTimeoutError());
  }, timeoutMs);

  try {
    const summary = await options.work(controller.signal, lease);
    if (controller.signal.aborted) throw controller.signal.reason;
    await options.store.append(eventFor(lease, 'SUCCEEDED', { summary }));
    return { exitCode: JOB_EXIT.SUCCESS, summary };
  } catch (error: unknown) {
    const leaseLost = error instanceof LeaseLostError
      || controller.signal.reason instanceof LeaseLostError;
    const timedOut = error instanceof JobTimeoutError
      || controller.signal.reason instanceof JobTimeoutError;
    await options.store.append(eventFor(lease, leaseLost ? 'LEASE_LOST' : 'FAILED', {
      errorCode: leaseLost ? 'LEASE_LOST' : timedOut ? 'JOB_TIMEOUT' : 'JOB_FAILED',
    }));
    return { exitCode: leaseLost ? JOB_EXIT.LEASE_LOST : JOB_EXIT.FAILURE };
  } finally {
    clearTimeout(deadline);
    timers.clearInterval(heartbeat);
    await options.store.release(lease);
  }
}
