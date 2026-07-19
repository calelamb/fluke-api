import { fetchAcartiaSnapshot } from '../lib/acartia.js';
import {
  reconcileExternalSightings,
  upsertExternalSightings,
  type ExternalSightingInput,
  type ExternalSightingRemovalClient,
  type ExternalSightingWriterClient,
} from './external-sighting-writer.js';
import { fetchGbifSnapshot } from './gbif-ingestion.js';
import type { JobLease, JobSummary } from './job-runner.js';

const WRITE_BATCH_SIZE = 200;

interface FencedWriter {
  runFenced<T>(
    lease: JobLease,
    operation: (
      client: ExternalSightingWriterClient & ExternalSightingRemovalClient
    ) => Promise<T>,
  ): Promise<T>;
}

export interface AuthoritativeProviderReconciliation {
  readonly authoritative: true;
  readonly observedFrom: Date;
  readonly observedTo: Date;
  readonly seenExternalIds: readonly string[];
  readonly source: 'acartia' | 'gbif';
}

export interface ProviderSnapshot {
  readonly reconciliation: AuthoritativeProviderReconciliation | null;
  readonly sightings: readonly ExternalSightingInput[];
}

type ProviderFetchResult = readonly ExternalSightingInput[] | ProviderSnapshot;

function isProviderSnapshot(result: ProviderFetchResult): result is ProviderSnapshot {
  return !Array.isArray(result);
}

interface IngestionJobOptions {
  readonly fetchSightings?: (signal: AbortSignal) => Promise<ProviderFetchResult>;
  readonly lease: JobLease;
  readonly signal: AbortSignal;
  readonly store: FencedWriter;
}

async function persist(
  options: IngestionJobOptions,
  provider: 'acartia' | 'gbif',
  fetchDefault: (signal: AbortSignal) => Promise<ProviderFetchResult>,
): Promise<JobSummary> {
  const result = await (options.fetchSightings ?? fetchDefault)(options.signal);
  if (options.signal.aborted) throw options.signal.reason;
  const snapshot: ProviderSnapshot = isProviderSnapshot(result)
    ? result
    : { reconciliation: null, sightings: result };
  if (
    snapshot.reconciliation
    && (
      snapshot.reconciliation.authoritative !== true
      || snapshot.reconciliation.source !== provider
    )
  ) {
    throw new Error(`Invalid ${provider} reconciliation scope`);
  }
  const { sightings } = snapshot;
  const batches = Array.from(
    { length: Math.ceil(sightings.length / WRITE_BATCH_SIZE) },
    (_, index) => sightings.slice(index * WRITE_BATCH_SIZE, (index + 1) * WRITE_BATCH_SIZE),
  );
  const fetchedAt = new Date();
  for (const batch of batches) {
    if (options.signal.aborted) throw options.signal.reason;
    await options.store.runFenced(options.lease, (client) => (
      upsertExternalSightings(client, batch, fetchedAt)
    ));
  }
  if (snapshot.reconciliation) {
    if (options.signal.aborted) throw options.signal.reason;
    const reconciliation = snapshot.reconciliation;
    await options.store.runFenced(options.lease, (client) => reconcileExternalSightings(
      client,
      reconciliation.source,
      reconciliation.seenExternalIds,
      reconciliation.observedFrom,
      reconciliation.observedTo,
      fetchedAt,
    ));
  }
  return Object.freeze({ processed: sightings.length, provider });
}

export function runAcartiaIngestion(options: IngestionJobOptions): Promise<JobSummary> {
  return persist(
    options,
    'acartia',
    (signal) => fetchAcartiaSnapshot({ signal }),
  );
}

export function runGbifIngestion(options: IngestionJobOptions): Promise<JobSummary> {
  return persist(
    options,
    'gbif',
    (signal) => fetchGbifSnapshot({ signal, years: 10 }),
  );
}
