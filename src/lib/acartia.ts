// Client for the Acartia / SSEMMI cooperative API.
//
// The "current" endpoint returns sightings from the last 7 days and does not
// require authentication. Sightings are pooled from multiple source orgs
// (Conserve.io / Spotter, Orca Network, Whale Alert, etc.) and tagged with
// `data_source_entity` for attribution.
//
// Docs:    https://github.com/salish-sea/acartia/blob/main/DOCS.md
// License: Creative Commons; honor attribution per data_source_entity.

import { z } from 'zod';
import { fetchJsonWithRetry } from '../jobs/provider-client.js';

const ACARTIA_CURRENT_URL = 'https://acartia.io/api/v1/sightings/current';

// The API returns numeric values as strings in many fields; coerce defensively.
const AcartiaSightingSchema = z
  .object({
    ssemmi_id: z.string(),
    entry_id: z.string().optional(),
    data_source_name: z.string().optional().default('unknown'),
    data_source_entity: z.string().optional().default(''),
    data_source_id: z.union([z.string(), z.number()]).optional(),
    data_source_comments: z.string().optional().nullable(),
    data_source_witness: z.string().optional().nullable(),
    created: z.string(),
    photo_url: z.string().optional().nullable(),
    no_sighted: z.union([z.string(), z.number()]).optional().nullable(),
    latitude: z.union([z.string(), z.number()]),
    longitude: z.union([z.string(), z.number()]),
    type: z.string(),
    trusted: z.union([z.boolean(), z.number()]).optional().default(0),
  })
  .passthrough();

export type AcartiaSighting = z.infer<typeof AcartiaSightingSchema>;

export interface NormalizedExternalSighting {
  source: 'acartia';
  externalId: string;
  observedAt: Date;
  latitude: number;
  longitude: number;
  species: string;
  ecotypeGuess: 'RESIDENT' | 'BIGGS' | 'OFFSHORE' | 'UNKNOWN' | null;
  groupSize: number | null;
  attribution: string;
  sourceUrl: string | null;
  notes: string | null;
  trusted: boolean;
}

const ORCA_TYPE_TOKENS = ['killer whale', 'orca', 'srkw', 'bigg', 'transient'];

function isOrca(type: string): boolean {
  const lower = type.toLowerCase();
  return ORCA_TYPE_TOKENS.some((token) => lower.includes(token));
}

function inferEcotype(
  type: string,
  notes?: string | null,
): NormalizedExternalSighting['ecotypeGuess'] {
  // Acartia's `type` is often generic ("Orca", "Killer Whale"); the ecotype
  // is more reliably found in the data_source_comments / notes string.
  const haystack = `${type} ${notes ?? ''}`.toLowerCase();
  if (haystack.includes('bigg') || haystack.includes('transient')) return 'BIGGS';
  if (
    haystack.includes('resident') ||
    haystack.includes('srkw') ||
    haystack.includes('northern resident')
  )
    return 'RESIDENT';
  if (haystack.includes('offshore')) return 'OFFSHORE';
  if (isOrca(type)) return 'UNKNOWN';
  return null;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value: string): Date | null {
  // Acartia uses 'YYYY-MM-DD HH:MM:SS' (assume UTC).
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isFiniteCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Normalise a raw Acartia sighting into our internal shape.
 * Returns null if the sighting is malformed, not an orca, or out of range.
 */
export function normalizeAcartiaSighting(
  raw: AcartiaSighting,
): NormalizedExternalSighting | null {
  if (!isOrca(raw.type)) return null;

  const lat = toNumber(raw.latitude);
  const lng = toNumber(raw.longitude);
  if (lat === null || lng === null || !isFiniteCoord(lat, lng)) return null;

  const observedAt = toDate(raw.created);
  if (!observedAt) return null;

  const groupSizeRaw = toNumber(raw.no_sighted);
  const groupSize =
    groupSizeRaw !== null && Number.isFinite(groupSizeRaw) && groupSizeRaw > 0
      ? Math.min(Math.round(groupSizeRaw), 200)
      : null;

  const attributionParts = [raw.data_source_entity, raw.data_source_name].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  const attribution =
    attributionParts.length > 0
      ? Array.from(new Set(attributionParts)).join(' / ')
      : 'Acartia (unknown source)';

  const trustedFlag = typeof raw.trusted === 'boolean' ? raw.trusted : raw.trusted === 1;

  const notes =
    raw.data_source_comments && raw.data_source_comments.length > 0
      ? raw.data_source_comments
      : null;

  return {
    source: 'acartia',
    externalId: raw.ssemmi_id,
    observedAt,
    latitude: lat,
    longitude: lng,
    species: raw.type,
    ecotypeGuess: inferEcotype(raw.type, notes),
    groupSize,
    attribution,
    sourceUrl: raw.photo_url && raw.photo_url.length > 0 ? raw.photo_url : null,
    notes,
    trusted: trustedFlag,
  };
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  url?: string;
}

/**
 * Fetch and normalise current Acartia sightings (last 7 days), filtered to
 * orca-relevant species. Returns an array of normalised records ready for
 * upsert into the external_sightings table.
 */
export async function fetchAcartiaCurrent(
  options: FetchOptions = {},
): Promise<NormalizedExternalSighting[]> {
  const url = options.url ?? ACARTIA_CURRENT_URL;
  const json = await fetchJsonWithRetry(url, {
    attemptTimeoutMs: 10_000,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    sleep: options.sleep,
  });
  if (!Array.isArray(json)) {
    throw new Error('Acartia returned an invalid payload');
  }
  if (json.length > 10_000) {
    throw new Error('Acartia returned too many records');
  }

  const out: NormalizedExternalSighting[] = [];
  for (const item of json) {
    const parsed = AcartiaSightingSchema.safeParse(item);
    if (!parsed.success) continue;
    const normalized = normalizeAcartiaSighting(parsed.data);
    if (normalized) out.push(normalized);
  }
  return out;
}
