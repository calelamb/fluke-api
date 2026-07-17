import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { runPredictionJob } from '../../src/jobs/prediction-job.js';
import type { JobLease } from '../../src/jobs/job-runner.js';
import type {
  PredictionObservationReader,
} from '../../src/jobs/prediction-observation-reader.js';

const lease: JobLease = Object.freeze({
  fence: 7n,
  jobName: 'prediction-compute',
  ownerToken: 'owner',
  runId: 'run',
});

describe('prediction job', () => {
  it('recomputes through fenced idempotent upserts', async () => {
    const row = Object.freeze({
      latitude: 48.5,
      longitude: -123,
      observedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const seasonalForWhale = vi.fn(async () => [row]);
    const seasonalForPod = vi.fn(async (pod: string) => pod === 'J' ? [row] : []);
    const reader: PredictionObservationReader = {
      latestForPod: vi.fn(async () => row),
      latestForWhale: vi.fn(async () => row),
      seasonalForPod,
      seasonalForWhale,
      whaleIds: vi.fn(async () => [{ id: 'J35' }]),
    };
    const upsert = vi.fn(async () => undefined);
    const client = {} as PrismaClient;
    const runFenced = vi.fn(async (_lease: JobLease, operation: (tx: unknown) => Promise<void>) => (
      operation({ predictionGrid: { upsert } })
    ));

    const options = {
      client,
      lease,
      now: new Date('2026-07-16T00:00:00.000Z'),
      reader,
      signal: new AbortController().signal,
      store: { runFenced },
    };
    const first = await runPredictionJob(options);
    const second = await runPredictionJob(options);

    expect(first).toEqual(second);
    expect(first).toEqual({ modelVersion: 'markov-v1', processed: 6 });
    expect(runFenced).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(12);
    expect(reader.whaleIds).toHaveBeenCalledWith(undefined, 101, expect.any(AbortSignal));
    expect(seasonalForWhale).toHaveBeenCalledWith('J35', 7, 5_001, expect.any(AbortSignal));
    expect(seasonalForPod).toHaveBeenCalledWith('J', 7, 5_001, expect.any(AbortSignal));
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      where: {
        subjectKind_subjectId_horizonHours: {
          horizonHours: 24,
          subjectId: 'J35',
          subjectKind: 'WHALE',
        },
      },
    });
  });

  it('bounds observation reads and stops between whale queries when aborted', async () => {
    const controller = new AbortController();
    const seasonalForWhale = vi.fn(async (_id: string, _month: number, take: number) => {
      expect(take).toBe(5_001);
      controller.abort(new Error('deadline exceeded'));
      return [];
    });
    const reader: PredictionObservationReader = {
      latestForPod: vi.fn(async () => null),
      latestForWhale: vi.fn(async () => null),
      seasonalForPod: vi.fn(async () => []),
      seasonalForWhale,
      whaleIds: vi.fn(async () => [{ id: 'J35' }, { id: 'J36' }]),
    };

    await expect(runPredictionJob({
      client: {} as PrismaClient,
      lease,
      reader,
      signal: controller.signal,
      store: { runFenced: vi.fn() },
    })).rejects.toThrow('deadline exceeded');
    expect(seasonalForWhale).toHaveBeenCalledOnce();
  });

  it('returns promptly when a database read stalls past cancellation', async () => {
    const controller = new AbortController();
    const never = new Promise<never>(() => undefined);
    const client = {
      $transaction: vi.fn(() => never),
    } as unknown as PrismaClient;
    const job = runPredictionJob({
      client,
      lease,
      signal: controller.signal,
      store: { runFenced: vi.fn() },
    });

    controller.abort(new Error('deadline exceeded'));
    const outcome = await Promise.race([
      job.then(() => 'resolved', (error: unknown) => error),
      new Promise<'still pending'>((resolve) => setTimeout(() => resolve('still pending'), 50)),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('deadline exceeded');
  });

  it('uses bounded target-month history without losing it to newer off-season rows', async () => {
    const julyHistory = [
      Object.freeze({ latitude: 48.1, longitude: -123.1, observedAt: new Date('2024-07-01T00:00:00.000Z') }),
      Object.freeze({ latitude: 48.2, longitude: -123.2, observedAt: new Date('2024-07-02T00:00:00.000Z') }),
    ];
    const decemberLatest = [
      Object.freeze({ latitude: 48.3, longitude: -123.3, observedAt: new Date('2025-12-01T00:00:00.000Z') }),
    ];
    const queryRaw = vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join(' ');
      if (sql.includes('set_config')) return [];
      if (sql.includes('EXTRACT')) return julyHistory;
      return [];
    });
    const transaction = {
      $queryRaw: queryRaw,
      externalSighting: { findMany: vi.fn(async () => []) },
      sighting: { findFirst: vi.fn(async () => decemberLatest[0]) },
      whale: { findMany: vi.fn(async () => [{ id: 'J35' }]) },
    };
    const client = {
      $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation(transaction)),
    } as unknown as PrismaClient;
    const upsert = vi.fn(async () => undefined);

    const result = await runPredictionJob({
      client,
      lease,
      now: new Date('2026-07-16T00:00:00.000Z'),
      signal: new AbortController().signal,
      store: {
        runFenced: vi.fn(async (_lease: JobLease, operation: (tx: unknown) => Promise<void>) => (
          operation({ predictionGrid: { upsert } })
        )),
      },
    });

    expect(result.processed).toBeGreaterThanOrEqual(3);
    expect(queryRaw.mock.calls.some(([parts]) => parts.join(' ').includes('EXTRACT'))).toBe(true);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ confidence: 0.04 }),
    }));
  });

  it('fails closed instead of silently truncating seasonal history', async () => {
    const row = Object.freeze({
      latitude: 48.5,
      longitude: -123,
      observedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const reader: PredictionObservationReader = {
      latestForPod: vi.fn(async () => null),
      latestForWhale: vi.fn(async () => row),
      seasonalForPod: vi.fn(async () => []),
      seasonalForWhale: vi.fn(async () => Array.from({ length: 5_001 }, () => row)),
      whaleIds: vi.fn(async () => [{ id: 'J35' }]),
    };

    await expect(runPredictionJob({
      client: {} as PrismaClient,
      lease,
      reader,
      signal: new AbortController().signal,
      store: { runFenced: vi.fn() },
    })).rejects.toThrow('exceeds 5000 rows');
  });

  it('paginates whale IDs deterministically', async () => {
    const firstPage = Array.from({ length: 101 }, (_, index) => ({
      id: `whale-${String(index).padStart(3, '0')}`,
    }));
    const whaleIds = vi.fn(async (cursor: string | undefined) => (
      cursor ? [firstPage[100]] : firstPage
    ));
    const reader: PredictionObservationReader = {
      latestForPod: vi.fn(async () => null),
      latestForWhale: vi.fn(async () => null),
      seasonalForPod: vi.fn(async () => []),
      seasonalForWhale: vi.fn(async () => []),
      whaleIds,
    };

    await expect(runPredictionJob({
      client: {} as PrismaClient,
      lease,
      reader,
      signal: new AbortController().signal,
      store: { runFenced: vi.fn() },
    })).resolves.toEqual({ modelVersion: 'markov-v1', processed: 0 });
    expect(whaleIds).toHaveBeenNthCalledWith(2, 'whale-099', 101, expect.any(AbortSignal));
  });

  it('checks cancellation between bounded write batches', async () => {
    const controller = new AbortController();
    const row = Object.freeze({
      latitude: 48.5,
      longitude: -123,
      observedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const reader: PredictionObservationReader = {
      latestForPod: vi.fn(async () => null),
      latestForWhale: vi.fn(async () => row),
      seasonalForPod: vi.fn(async () => []),
      seasonalForWhale: vi.fn(async () => [row]),
      whaleIds: vi.fn(async () => Array.from({ length: 40 }, (_, index) => ({ id: `whale-${index}` }))),
    };
    const upsert = vi.fn(async () => {
      if (upsert.mock.calls.length === 101) controller.abort(new Error('write deadline exceeded'));
    });
    const runFenced = vi.fn(async (_lease: JobLease, operation: (tx: unknown) => Promise<void>) => (
      operation({ predictionGrid: { upsert } })
    ));

    await expect(runPredictionJob({
      client: {} as PrismaClient,
      lease,
      reader,
      signal: controller.signal,
      store: { runFenced },
    })).rejects.toThrow('write deadline exceeded');
    expect(runFenced).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(101);
  });
});
