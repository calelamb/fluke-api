import { fetchAcartiaCurrent } from '../lib/acartia.js';
import {
  upsertExternalSightings,
  type ExternalSightingInput,
  type ExternalSightingWriterClient,
} from './external-sighting-writer.js';
import { fetchGbifSightings } from './gbif-ingestion.js';
import type { JobLease, JobSummary } from './job-runner.js';

interface FencedWriter {
  runFenced<T>(
    lease: JobLease,
    operation: (client: ExternalSightingWriterClient) => Promise<T>,
  ): Promise<T>;
}

interface IngestionJobOptions {
  readonly fetchSightings?: (signal: AbortSignal) => Promise<readonly ExternalSightingInput[]>;
  readonly lease: JobLease;
  readonly signal: AbortSignal;
  readonly store: FencedWriter;
}

async function persist(
  options: IngestionJobOptions,
  provider: 'acartia' | 'gbif',
  fetchDefault: (signal: AbortSignal) => Promise<readonly ExternalSightingInput[]>,
): Promise<JobSummary> {
  const sightings = await (options.fetchSightings ?? fetchDefault)(options.signal);
  if (options.signal.aborted) throw options.signal.reason;
  const processed = await options.store.runFenced(options.lease, (client) => (
    upsertExternalSightings(client, sightings, new Date())
  ));
  return Object.freeze({ processed, provider });
}

export function runAcartiaIngestion(options: IngestionJobOptions): Promise<JobSummary> {
  return persist(
    options,
    'acartia',
    (signal) => fetchAcartiaCurrent({ signal }),
  );
}

export function runGbifIngestion(options: IngestionJobOptions): Promise<JobSummary> {
  return persist(
    options,
    'gbif',
    (signal) => fetchGbifSightings({ signal, years: 10 }),
  );
}
