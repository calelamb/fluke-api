import { describe, expect, it } from 'vitest';
import { classifyPublicSighting } from '../src/lib/public-data-hygiene.js';

const legitimateSighting = Object.freeze({
  behaviorNotes: 'Researchers tested a hydrophone after the whales passed.',
  id: '0c567795-2914-44d8-8b0c-f0ce0e8f6780',
  locationName: 'Haro Strait',
  observerEmail: 'observer@orca.example.org',
});

describe('public sighting data hygiene', () => {
  it.each([
    ['diagnostic-test-pin', 'known-synthetic-id'],
    ['fixture-sighting', 'known-synthetic-id'],
    ['synthetic-sighting', 'known-synthetic-id'],
  ] as const)('blocks the known synthetic ID %s', (id, reason) => {
    expect(classifyPublicSighting({ ...legitimateSighting, id })).toEqual({ recordId: id, reason });
  });

  it.each([
    ['Diagnostic test pin', null],
    [null, '[fixture] generated sighting'],
    [null, '[synthetic] release smoke test'],
    [null, '[test only] do not publish'],
  ] as const)('blocks explicit diagnostic text without echoing it', (locationName, behaviorNotes) => {
    expect(classifyPublicSighting({
      ...legitimateSighting,
      behaviorNotes,
      locationName,
    })).toEqual({
      recordId: legitimateSighting.id,
      reason: 'explicit-synthetic-marker',
    });
  });

  it('blocks the reserved .invalid observer domain without returning private data', () => {
    const result = classifyPublicSighting({
      ...legitimateSighting,
      observerEmail: 'private-observer@release-check.invalid',
    });

    expect(result).toEqual({
      recordId: legitimateSighting.id,
      reason: 'reserved-observer-domain',
    });
    expect(JSON.stringify(result)).not.toContain('private-observer');
  });

  it('allows legitimate provider-like and user records that merely discuss testing', () => {
    expect(classifyPublicSighting(legitimateSighting)).toBeNull();
    expect(classifyPublicSighting({
      ...legitimateSighting,
      behaviorNotes: 'Testing the current before heading back to shore.',
      locationName: 'Testalinden Creek',
    })).toBeNull();
  });
});
