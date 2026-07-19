import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  probeFeedDependencies,
  probeSubmissionDependencies,
} from '../app.js';

type FindFirst = ReturnType<typeof vi.fn<(query?: unknown) => Promise<null>>>;

function relation(findFirst: FindFirst = vi.fn(async () => null)) {
  return Object.freeze({ findFirst });
}

function transactionWithReads(overrides: Readonly<Record<string, FindFirst>> = {}) {
  const findFirst = (name: string): FindFirst => overrides[name] ?? vi.fn(async () => null);
  const reads = Object.freeze({
    externalSighting: findFirst('externalSighting'),
    identifierRelease: findFirst('identifierRelease'),
    jobRunEvent: findFirst('jobRunEvent'),
    sighting: findFirst('sighting'),
    sightingIdentificationSuggestion: findFirst('sightingIdentificationSuggestion'),
    sightingPhoto: findFirst('sightingPhoto'),
    sightingWhale: findFirst('sightingWhale'),
    submissionIdempotency: findFirst('submissionIdempotency'),
    whale: findFirst('whale'),
  });
  return Object.freeze({
    reads,
    transaction: Object.freeze({
      externalSighting: relation(reads.externalSighting),
      identifierRelease: relation(reads.identifierRelease),
      jobRunEvent: relation(reads.jobRunEvent),
      sighting: relation(reads.sighting),
      sightingIdentificationSuggestion: relation(reads.sightingIdentificationSuggestion),
      sightingPhoto: relation(reads.sightingPhoto),
      sightingWhale: relation(reads.sightingWhale),
      submissionIdempotency: relation(reads.submissionIdempotency),
      whale: relation(reads.whale),
    }) as unknown as Prisma.TransactionClient,
  });
}

describe('on-device readiness dependency probes', () => {
  it('reads every public-feed table directly with bounded projections', async () => {
    const { reads, transaction } = transactionWithReads();

    await probeFeedDependencies(transaction);

    for (const name of [
      'externalSighting',
      'jobRunEvent',
      'sighting',
      'sightingPhoto',
      'sightingWhale',
      'whale',
    ] as const) {
      expect(reads[name], name).toHaveBeenCalledOnce();
      expect(reads[name].mock.calls[0]?.[0]).toMatchObject({ select: expect.any(Object) });
    }
  });

  it('fails the feed probe when a required relation is denied', async () => {
    const denied = vi.fn(async () => { throw new Error('job_run_events permission denied'); });
    const { transaction } = transactionWithReads({ jobRunEvent: denied });

    await expect(probeFeedDependencies(transaction)).rejects.toThrow('permission denied');
  });

  it('reads submission and local-evidence relations directly with bounded projections', async () => {
    const { reads, transaction } = transactionWithReads();

    await probeSubmissionDependencies(transaction);

    for (const name of [
      'identifierRelease',
      'sighting',
      'sightingIdentificationSuggestion',
      'submissionIdempotency',
      'whale',
    ] as const) {
      expect(reads[name], name).toHaveBeenCalledOnce();
      expect(reads[name].mock.calls[0]?.[0]).toMatchObject({ select: expect.any(Object) });
    }
    expect(reads.identifierRelease).toHaveBeenCalledWith({
      select: { catalogInventory: true, manifestVersion: true },
    });
    expect(reads.whale).toHaveBeenCalledWith({ select: { catalogId: true, id: true } });
  });

  it('fails the submission probe when a local-evidence relation is missing', async () => {
    const missing = vi.fn(async () => { throw new Error('relation does not exist'); });
    const { transaction } = transactionWithReads({ sightingIdentificationSuggestion: missing });

    await expect(probeSubmissionDependencies(transaction)).rejects.toThrow('relation does not exist');
  });
});
