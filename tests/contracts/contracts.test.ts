import { describe, expect, it } from 'vitest';
import {
  ExternalSightingsQuerySchema,
  HistoricalSightingsQuerySchema,
  PageInfoSchema,
  PublicErrorCodeSchema,
  SafeErrorSchema,
  SightingsQuerySchema,
  WhaleTrackSchema,
  WhalesQuerySchema,
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

  it('accepts only the canonical safe public error envelope', () => {
    const value = {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      requestId: 'req-fixture-1',
      retryable: false,
    };

    expect(SafeErrorSchema.parse(value)).toEqual(value);
    expect(PublicErrorCodeSchema.safeParse('provider stack trace').success).toBe(false);
    expect(SafeErrorSchema.safeParse({ error: 'legacy' }).success).toBe(false);
  });

  it('validates an identified whale track and rejects invalid coordinates', () => {
    const track = {
      whaleId: 'fixture-whale-alpha',
      catalogId: 'FX-001',
      points: [{
        id: 'fixture-sighting-1',
        observedAt: '2026-07-16T18:00:00.000Z',
        latitude: 48.5,
        longitude: -123.25,
        locationName: null,
        behaviorNotes: null,
      }],
    };

    expect(WhaleTrackSchema.parse(track)).toEqual(track);
    expect(WhaleTrackSchema.safeParse({
      ...track,
      points: [{ ...track.points[0], latitude: 91 }],
    }).success).toBe(false);
  });

  it('bounds and validates Release A list queries', () => {
    expect(WhalesQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(WhalesQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(SightingsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ExternalSightingsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(HistoricalSightingsQuerySchema.safeParse({
      from: '2026-07-17T00:00:00.000Z',
      to: '2026-07-16T00:00:00.000Z',
    }).success).toBe(false);
    expect(HistoricalSightingsQuerySchema.safeParse({ pod: 'Q' }).success).toBe(false);
    expect(HistoricalSightingsQuerySchema.safeParse({
      from: '2024-07-16T00:00:00.000Z',
      to: '2026-07-16T00:00:00.000Z',
    }).success).toBe(false);
    expect(HistoricalSightingsQuerySchema.safeParse({
      from: '2026-07-16T00:00:00.000Z',
    }).success).toBe(false);
  });

  it('keeps cursor metadata internally consistent', () => {
    expect(PageInfoSchema.safeParse({ hasMore: true, nextCursor: null }).success).toBe(false);
    expect(PageInfoSchema.safeParse({ hasMore: false, nextCursor: 'unexpected' }).success).toBe(false);
    expect(PageInfoSchema.safeParse({ hasMore: true, nextCursor: 'cursor-1' }).success).toBe(true);
  });
});
