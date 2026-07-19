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

  it('bounds each fenced transaction for large provider responses', async () => {
    const upsert = vi.fn(async () => undefined);
    const runFenced = vi.fn(async (_lease: JobLease, operation: (client: unknown) => Promise<number>) => (
      operation({ externalSighting: { upsert } })
    ));
    const sightings = Array.from({ length: 201 }, (_, index) => ({
      ...sighting,
      externalId: `provider-${index}`,
    }));

    const summary = await runGbifIngestion({
      fetchSightings: async () => sightings,
      lease,
      signal: new AbortController().signal,
      store: { runFenced },
    });

    expect(summary).toEqual({ processed: 201, provider: 'gbif' });
    expect(runFenced).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(201);
  });

  it('reconciles only an explicitly authoritative provider snapshot behind the fence', async () => {
    const upsert = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const runFenced = vi.fn(async (_lease: JobLease, operation: (client: unknown) => Promise<number>) => (
      operation({ externalSighting: { updateMany, upsert } })
    ));
    const observedFrom = new Date('2026-07-09T00:00:00.000Z');
    const observedTo = new Date('2026-07-16T00:00:00.000Z');

    const summary = await runAcartiaIngestion({
      fetchSightings: async () => ({
        reconciliation: {
          authoritative: true as const,
          observedFrom,
          observedTo,
          seenExternalIds: [sighting.externalId],
          source: 'acartia' as const,
        },
        sightings: [{ ...sighting, source: 'acartia' as const }],
      }),
      lease,
      signal: new AbortController().signal,
      store: { runFenced },
    });

    expect(summary).toEqual({ processed: 1, provider: 'acartia' });
    expect(runFenced).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        fetchedAt: expect.any(Date),
        publicFeedRemovedAt: expect.any(Date),
      },
      where: expect.objectContaining({
        externalId: { notIn: [sighting.externalId] },
        observedAt: { gte: observedFrom, lte: observedTo },
        publicFeedRemovedAt: null,
        source: 'acartia',
      }),
    }));
  });

  it('does not reconcile ambiguous or failed provider fetches', async () => {
    const runFenced = vi.fn();
    await expect(runGbifIngestion({
      fetchSightings: async () => {
        throw new Error('partial provider response');
      },
      lease,
      signal: new AbortController().signal,
      store: { runFenced },
    })).rejects.toThrow('partial provider response');
    expect(runFenced).not.toHaveBeenCalled();
  });
});
