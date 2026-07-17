import { describe, expect, it, vi } from 'vitest';
import { runAcartiaIngestion, runGbifIngestion } from '../../src/jobs/ingestion-jobs.js';
import type { JobLease } from '../../src/jobs/job-runner.js';

const lease: JobLease = Object.freeze({
  fence: 4n,
  jobName: 'provider-ingest',
  ownerToken: 'owner',
  runId: 'run',
});

const sighting = Object.freeze({
  attribution: 'Provider',
  ecotypeGuess: 'UNKNOWN' as const,
  externalId: 'provider-1',
  groupSize: 2,
  latitude: 48.5,
  longitude: -123,
  notes: null,
  observedAt: new Date('2026-07-16T00:00:00.000Z'),
  source: 'provider',
  sourceUrl: null,
  species: 'Orca',
  trusted: true,
});

describe('provider ingestion jobs', () => {
  it('places every Acartia write behind the current fence', async () => {
    const upsert = vi.fn(async () => undefined);
    const runFenced = vi.fn(async (_lease: JobLease, operation: (client: unknown) => Promise<number>) => (
      operation({ externalSighting: { upsert } })
    ));

    const summary = await runAcartiaIngestion({
      fetchSightings: async () => [sighting],
      lease,
      signal: new AbortController().signal,
      store: { runFenced },
    });

    expect(summary).toEqual({ processed: 1, provider: 'acartia' });
    expect(runFenced).toHaveBeenCalledOnce();
    expect(runFenced).toHaveBeenCalledWith(lease, expect.any(Function));
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('places every GBIF write behind the current fence', async () => {
    const upsert = vi.fn(async () => undefined);
    const runFenced = vi.fn(async (_lease: JobLease, operation: (client: unknown) => Promise<number>) => (
      operation({ externalSighting: { upsert } })
    ));

    const summary = await runGbifIngestion({
      fetchSightings: async () => [sighting],
      lease,
      signal: new AbortController().signal,
      store: { runFenced },
    });

    expect(summary).toEqual({ processed: 1, provider: 'gbif' });
    expect(runFenced).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledOnce();
  });
});
