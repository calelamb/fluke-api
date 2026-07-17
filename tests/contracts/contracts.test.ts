import { describe, expect, it } from 'vitest';
import {
  ExternalSightingSchema,
  IdentifyResponseSchema,
  PredictionSchema,
  SightingSchema,
  SubmitSightingPayloadSchema,
  WhaleProfileSchema,
  WhaleSchema,
} from '../../src/contracts/index.js';

describe('public API contracts', () => {
  it.each([
    ['Whale', WhaleSchema],
    ['WhaleProfile', WhaleProfileSchema],
    ['Sighting', SightingSchema],
    ['ExternalSighting', ExternalSightingSchema],
    ['Prediction', PredictionSchema],
    ['IdentifyResponse', IdentifyResponseSchema],
  ])('%s rejects an empty object', (_name, schema) => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('preserves submission validation behavior for unknown keys and whitespace', () => {
    const result = SubmitSightingPayloadSchema.safeParse({
      observedAt: '2026-07-16T18:00:00.000Z',
      latitude: 48.5,
      longitude: -123.25,
      locationName: '  Salish Sea  ',
      observerEmail: 'observer@example.com',
      futureClientField: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.locationName).toBe('  Salish Sea  ');
    }
  });
});
