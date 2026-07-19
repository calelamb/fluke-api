import { describe, expect, it, vi } from 'vitest';
import {
  fetchGbifSightings,
  fetchGbifSnapshot,
} from '../../src/jobs/gbif-ingestion.js';

const record = Object.freeze({
  basisOfRecord: 'OBSERVATION',
  decimalLatitude: 48.5,
  decimalLongitude: -123,
  eventDate: '2026-07-16T00:00:00Z',
  key: 42,
  publisher: 'Research provider',
  species: 'Orcinus orca',
});

function page(
  results: readonly unknown[],
  endOfRecords: boolean,
  count = results.length,
): Response {
  return new Response(JSON.stringify({ count, endOfRecords, results }));
}

function records(count: number, startingKey = 1): readonly typeof record[] {
  return Array.from({ length: count }, (_, index) => Object.freeze({
    ...record,
    key: startingKey + index,
  }));
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
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      return page(records(300, offset + 1), false, 15_001);
    });

    await fetchGbifSightings({
      fetchImpl,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(50);

    const snapshot = await fetchGbifSnapshot({
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const offset = Number(new URL(String(input)).searchParams.get('offset'));
        return page(records(300, offset + 1), false, 15_001);
      }),
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    });
    expect(snapshot.reconciliation).toBeNull();
  });

  it('fails closed when an empty page is marked nonterminal', async () => {
    const snapshot = await fetchGbifSnapshot({
      fetchImpl: vi.fn(async () => page([], false, 2)),
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    });

    expect(snapshot.reconciliation).toBeNull();
  });

  it('fails closed when a short page is marked nonterminal', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([record], false, 2))
      .mockResolvedValueOnce(page([{ ...record, key: 43 }], true, 2));

    const snapshot = await fetchGbifSnapshot({
      fetchImpl,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    });

    expect(snapshot.reconciliation).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the provider count changes during pagination', async () => {
    const firstPage = records(300);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page(firstPage, false, 301))
      .mockResolvedValueOnce(page([{ ...record, key: 301 }], true, 302));

    const snapshot = await fetchGbifSnapshot({
      fetchImpl,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    });

    expect(snapshot.reconciliation).toBeNull();
  });

  it('fails closed when a stable-count scan repeats an occurrence across pages', async () => {
    const firstPage = records(300);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page(firstPage, false, 301))
      .mockResolvedValueOnce(page([{ ...record, key: 300 }], true, 301));

    const snapshot = await fetchGbifSnapshot({
      fetchImpl,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    });

    expect(snapshot.reconciliation).toBeNull();
  });

  it('returns an authoritative snapshot after a stable complete multipage scan', async () => {
    const firstPage = records(300);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page(firstPage, false, 301))
      .mockResolvedValueOnce(page([{ ...record, key: 301 }], true, 301));

    const snapshot = await fetchGbifSnapshot({
      fetchImpl,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    });

    expect(snapshot.reconciliation).toEqual(expect.objectContaining({
      authoritative: true,
      seenExternalIds: expect.arrayContaining(['1', '300', '301']),
      source: 'gbif',
    }));
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('offset=300');
  });

  it('rejects a provider failure without producing a snapshot', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 }));

    await expect(fetchGbifSnapshot({
      fetchImpl,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      years: 5,
    })).rejects.toThrow();
  });
});
