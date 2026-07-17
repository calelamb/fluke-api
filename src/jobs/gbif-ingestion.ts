import { z } from 'zod';
import type { ExternalSightingInput } from './external-sighting-writer.js';
import { fetchJsonWithRetry } from './provider-client.js';

const GBIF_BASE_URL = 'https://api.gbif.org/v1/occurrence/search';
const PAGE_SIZE = 300;
const MAX_PAGES = 50;
const SALISH_SEA_BOUNDS = Object.freeze({
  east: -122,
  north: 49.5,
  south: 47,
  west: -124.7,
});

const GbifRecordSchema = z.object({
  basisOfRecord: z.string().optional(),
  datasetName: z.string().optional(),
  decimalLatitude: z.number().finite(),
  decimalLongitude: z.number().finite(),
  eventDate: z.string().min(1),
  key: z.number().int().nonnegative(),
  occurrenceRemarks: z.string().optional(),
  publisher: z.string().optional(),
  recordedBy: z.string().optional(),
  references: z.string().optional(),
  species: z.string().optional(),
}).passthrough();

const GbifPageSchema = z.object({
  count: z.number().int().nonnegative(),
  endOfRecords: z.boolean(),
  results: z.array(GbifRecordSchema).max(PAGE_SIZE),
}).passthrough();

type GbifRecord = z.infer<typeof GbifRecordSchema>;

export interface GbifFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly signal: AbortSignal;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly years: number;
}

function inSalishSea(record: GbifRecord): boolean {
  return record.decimalLatitude >= SALISH_SEA_BOUNDS.south
    && record.decimalLatitude <= SALISH_SEA_BOUNDS.north
    && record.decimalLongitude >= SALISH_SEA_BOUNDS.west
    && record.decimalLongitude <= SALISH_SEA_BOUNDS.east;
}

function inferEcotype(record: GbifRecord): ExternalSightingInput['ecotypeGuess'] {
  const text = `${record.occurrenceRemarks ?? ''} ${record.recordedBy ?? ''} ${record.datasetName ?? ''}`.toLowerCase();
  if (text.includes('bigg') || text.includes('transient')) return 'BIGGS';
  if (text.includes('resident') || text.includes('srkw')) return 'RESIDENT';
  return 'UNKNOWN';
}

function safeSourceUrl(record: GbifRecord): string {
  if (record.references) {
    try {
      const parsed = new URL(record.references);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
    } catch {
      // Fall through to the stable GBIF record URL.
    }
  }
  return `https://www.gbif.org/occurrence/${record.key}`;
}

function normalizeRecord(record: GbifRecord): ExternalSightingInput | null {
  if (!inSalishSea(record)) return null;
  const observedAt = new Date(record.eventDate);
  if (Number.isNaN(observedAt.getTime())) return null;
  return Object.freeze({
    attribution: (record.publisher ?? record.datasetName ?? 'GBIF').slice(0, 500),
    ecotypeGuess: inferEcotype(record),
    externalId: String(record.key),
    groupSize: null,
    latitude: record.decimalLatitude,
    longitude: record.decimalLongitude,
    notes: record.occurrenceRemarks?.slice(0, 2_000) ?? null,
    observedAt,
    source: 'gbif',
    sourceUrl: safeSourceUrl(record),
    species: (record.species ?? 'Orcinus orca').slice(0, 200),
    trusted: record.basisOfRecord === 'HUMAN_OBSERVATION'
      || record.basisOfRecord === 'OBSERVATION',
  });
}

function providerUrl(offset: number, years: number): string {
  const currentYear = new Date().getUTCFullYear();
  const params = new URLSearchParams({
    decimalLatitude: `${SALISH_SEA_BOUNDS.south},${SALISH_SEA_BOUNDS.north}`,
    decimalLongitude: `${SALISH_SEA_BOUNDS.west},${SALISH_SEA_BOUNDS.east}`,
    hasCoordinate: 'true',
    limit: String(PAGE_SIZE),
    offset: String(offset),
    scientificName: 'Orcinus orca',
    year: `${currentYear - years},${currentYear}`,
  });
  return `${GBIF_BASE_URL}?${params}`;
}

export async function fetchGbifSightings(
  options: GbifFetchOptions,
): Promise<ExternalSightingInput[]> {
  if (!Number.isInteger(options.years) || options.years < 1 || options.years > 20) {
    throw new Error('years must be between 1 and 20');
  }

  const sightings = new Map<string, ExternalSightingInput>();
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const payload = await fetchJsonWithRetry(providerUrl(pageIndex * PAGE_SIZE, options.years), {
      attemptTimeoutMs: 15_000,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      sleep: options.sleep,
    });
    const page = GbifPageSchema.parse(payload);
    for (const record of page.results) {
      const normalized = normalizeRecord(record);
      if (normalized) sightings.set(normalized.externalId, normalized);
    }
    if (page.endOfRecords || page.results.length === 0) break;
  }
  return [...sightings.values()];
}
