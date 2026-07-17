import { describe, expect, it, vi } from 'vitest';
import { fetchGbifSightings } from '../../src/jobs/gbif-ingestion.js';

const record = Object.freeze({
  basisOfRecord: 'OBSERVATION',
  decimalLatitude: 48.5,
  decimalLongitude: -123,
  eventDate: '2026-07-16T00:00:00Z',
  key: 42,
  publisher: 'Research provider',
  species: 'Orcinus orca',
});

function page(results: readonly unknown[], endOfRecords: boolean): Response {
  return new Response(JSON.stringify({ count: results.length, endOfRecords, results }));
}

describe('fetchGbifSightings', () => {
  it('normalizes a validated provider page', async () => {
    const fetchImpl = vi.fn(async () => page([record], true));

    const result = await fetchGbifSightings({
      fetchImpl,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    });

    expect(result).toEqual([
      expect.objectContaining({ externalId: '42', source: 'gbif', trusted: true }),
    ]);
  });

  it('falls back to the stable record URL when provider references are oversized', async () => {
    const fetchImpl = vi.fn(async () => page([{
      ...record,
      references: 'https://provider.example/'.padEnd(2_049, 'a'),
    }], true));

    const result = await fetchGbifSightings({
      fetchImpl,
      signal: new AbortController().signal,
      years: 5,
    });

    expect(result[0]?.sourceUrl).toBe('https://www.gbif.org/occurrence/42');
  });

  it('rejects an unsafe lookback before calling the provider', async () => {
    const fetchImpl = vi.fn(async () => page([], true));

    await expect(fetchGbifSightings({
      fetchImpl,
      signal: new AbortController().signal,
      years: 0,
    })).rejects.toThrow('years must be between 1 and 20');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never requests more than fifty provider pages', async () => {
    const fetchImpl = vi.fn(async () => page([record], false));

    await fetchGbifSightings({
      fetchImpl,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(50);
  });
});
