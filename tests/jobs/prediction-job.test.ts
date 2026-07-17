import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { runPredictionJob } from '../../src/jobs/prediction-job.js';
import type { JobLease } from '../../src/jobs/job-runner.js';

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
    const findSightings = vi.fn(async (args: { where: Record<string, unknown> }) => {
      const where = JSON.stringify(args.where);
      return where.includes('whaleId') || where.includes('"pod":"J"') ? [row] : [];
    });
    const upsert = vi.fn(async () => undefined);
    const client = {
      externalSighting: { findMany: async () => [] },
      sighting: { findMany: findSightings },
      whale: { findMany: async () => [{ ecotype: 'RESIDENT', id: 'J35', pod: 'J' }] },
    } as unknown as PrismaClient;
    const runFenced = vi.fn(async (_lease: JobLease, operation: (tx: unknown) => Promise<void>) => (
      operation({ predictionGrid: { upsert } })
    ));

    const options = {
      client,
      lease,
      now: new Date('2026-07-16T00:00:00.000Z'),
      signal: new AbortController().signal,
      store: { runFenced },
    };
    const first = await runPredictionJob(options);
    const second = await runPredictionJob(options);

    expect(first).toEqual(second);
    expect(first).toEqual({ modelVersion: 'markov-v1', processed: 6 });
    expect(runFenced).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(12);
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
});
