import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  fetchAcartiaCurrent,
  normalizeAcartiaSighting,
  type AcartiaSighting,
} from '../lib/acartia.js';

const baseRaw: AcartiaSighting = {
  ssemmi_id: 'SPOTTER 1',
  data_source_name: 'Spotter-API',
  data_source_entity: 'Conserve.io',
  created: '2026-04-22 00:48:20',
  latitude: '48.62696',
  longitude: '-123.02971',
  type: 'Killer Whale',
  no_sighted: '3',
  trusted: 1,
  data_source_comments: 'Travelling north',
  photo_url: '',
};

describe('normalizeAcartiaSighting', () => {
  it('normalises a well-formed killer whale sighting', () => {
    const result = normalizeAcartiaSighting(baseRaw);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe('acartia');
    expect(result.externalId).toBe('SPOTTER 1');
    expect(result.latitude).toBeCloseTo(48.62696, 5);
    expect(result.longitude).toBeCloseTo(-123.02971, 5);
    expect(result.species).toBe('Killer Whale');
    expect(result.ecotypeGuess).toBe('UNKNOWN');
    expect(result.groupSize).toBe(3);
    expect(result.attribution).toContain('Conserve.io');
    expect(result.trusted).toBe(true);
    expect(result.notes).toBe('Travelling north');
  });

  it('rejects non-orca species (returns null)', () => {
    expect(normalizeAcartiaSighting({ ...baseRaw, type: 'Harbor Porpoise' })).toBeNull();
    expect(normalizeAcartiaSighting({ ...baseRaw, type: 'Humpback Whale' })).toBeNull();
    expect(normalizeAcartiaSighting({ ...baseRaw, type: 'Steller Sea Lion' })).toBeNull();
  });

  it("infers BIGGS ecotype from 'Bigg' or 'Transient' in the type string", () => {
    expect(normalizeAcartiaSighting({ ...baseRaw, type: "Bigg's Killer Whale" })?.ecotypeGuess).toBe('BIGGS');
    expect(normalizeAcartiaSighting({ ...baseRaw, type: 'Transient Orca' })?.ecotypeGuess).toBe('BIGGS');
  });

  it("infers RESIDENT ecotype from 'Resident' or 'SRKW' in the type string", () => {
    expect(normalizeAcartiaSighting({ ...baseRaw, type: 'Southern Resident Killer Whale' })?.ecotypeGuess).toBe('RESIDENT');
    expect(normalizeAcartiaSighting({ ...baseRaw, type: 'SRKW' })?.ecotypeGuess).toBe('RESIDENT');
  });

  it('falls back to scanning notes when the type string is generic', () => {
    // Real Acartia rows often have type='Orca' with ecotype in the comment.
    expect(
      normalizeAcartiaSighting({
        ...baseRaw,
        type: 'Orca',
        data_source_comments: '[Orca Network] Biggs group of orcas westbound',
      })?.ecotypeGuess,
    ).toBe('BIGGS');
    expect(
      normalizeAcartiaSighting({
        ...baseRaw,
        type: 'Killer Whale',
        data_source_comments: 'SRKW J pod heading north past Lime Kiln',
      })?.ecotypeGuess,
    ).toBe('RESIDENT');
  });

  it('rejects out-of-range coordinates', () => {
    expect(normalizeAcartiaSighting({ ...baseRaw, latitude: '500' })).toBeNull();
    expect(normalizeAcartiaSighting({ ...baseRaw, longitude: '-999' })).toBeNull();
  });

  it('rejects malformed dates', () => {
    expect(normalizeAcartiaSighting({ ...baseRaw, created: 'not-a-date' })).toBeNull();
  });

  it('clamps absurd group sizes and treats non-positive values as null', () => {
    expect(normalizeAcartiaSighting({ ...baseRaw, no_sighted: '5000' })?.groupSize).toBe(200);
    expect(normalizeAcartiaSighting({ ...baseRaw, no_sighted: '0' })?.groupSize).toBeNull();
    expect(normalizeAcartiaSighting({ ...baseRaw, no_sighted: null })?.groupSize).toBeNull();
  });

  it('falls back to a sensible attribution when source fields are missing', () => {
    const result = normalizeAcartiaSighting({
      ...baseRaw,
      data_source_entity: '',
      data_source_name: '',
    });
    expect(result?.attribution).toBe('Acartia (unknown source)');
  });

  it('treats numeric and boolean trusted values consistently', () => {
    expect(normalizeAcartiaSighting({ ...baseRaw, trusted: 0 })?.trusted).toBe(false);
    expect(normalizeAcartiaSighting({ ...baseRaw, trusted: 1 })?.trusted).toBe(true);
    expect(normalizeAcartiaSighting({ ...baseRaw, trusted: true })?.trusted).toBe(true);
    expect(normalizeAcartiaSighting({ ...baseRaw, trusted: false })?.trusted).toBe(false);
  });

  it('rejects unsafe identities and strips unsafe provider URLs', () => {
    expect(normalizeAcartiaSighting({ ...baseRaw, ssemmi_id: '' })).toBeNull();
    expect(normalizeAcartiaSighting({ ...baseRaw, ssemmi_id: 'x'.repeat(201) })).toBeNull();
    expect(normalizeAcartiaSighting({
      ...baseRaw,
      photo_url: 'javascript:alert(1)',
    })?.sourceUrl).toBeNull();
    expect(normalizeAcartiaSighting({
      ...baseRaw,
      photo_url: 'https://provider.example/photo.jpg',
    })?.sourceUrl).toBe('https://provider.example/photo.jpg');
    expect(normalizeAcartiaSighting({
      ...baseRaw,
      photo_url: 'https://provider.example/'.padEnd(2_049, 'a'),
    })?.sourceUrl).toBeNull();
  });
});

describe('fetchAcartiaCurrent', () => {
  it('uses the bounded provider retry policy before normalizing data', async () => {
    const responses = [
      new Response('{}', { status: 503 }),
      new Response(JSON.stringify([baseRaw]), { status: 200 }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? new Response('{}', { status: 500 }));

    const result = await fetchAcartiaCurrent({
      fetchImpl,
      sleep: async () => undefined,
      url: 'https://provider.example/current',
    });

    expect(result).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
