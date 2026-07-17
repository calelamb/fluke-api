import { describe, expect, it, vi } from 'vitest';
import { upsertExternalSightings } from '../../src/jobs/external-sighting-writer.js';
import type { NormalizedExternalSighting } from '../../src/lib/acartia.js';

const sighting: NormalizedExternalSighting = Object.freeze({
  attribution: 'Provider',
  ecotypeGuess: 'UNKNOWN',
  externalId: 'provider-1',
  groupSize: 2,
  latitude: 48.5,
  longitude: -123,
  notes: null,
  observedAt: new Date('2026-07-16T00:00:00.000Z'),
  source: 'acartia',
  sourceUrl: null,
  species: 'Orca',
  trusted: true,
});

describe('upsertExternalSightings', () => {
  it('uses the provider identity as an atomic idempotency key', async () => {
    const upsert = vi.fn(async () => undefined);
    const client = { externalSighting: { upsert } };
    const fetchedAt = new Date('2026-07-16T01:00:00.000Z');

    await upsertExternalSightings(client, [sighting], fetchedAt);
    await upsertExternalSightings(client, [sighting], fetchedAt);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenLastCalledWith({
      create: expect.objectContaining({ externalId: 'provider-1', source: 'acartia' }),
      update: expect.objectContaining({ fetchedAt }),
      where: {
        source_externalId: { externalId: 'provider-1', source: 'acartia' },
      },
    });
  });
});
