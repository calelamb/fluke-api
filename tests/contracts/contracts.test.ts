import { describe, expect, it } from 'vitest';
import {
  AuthAppleRequestSchema,
  AuthAppleResponseSchema,
  ExternalSightingsQuerySchema,
  HistoricalSightingsQuerySchema,
  MySightingPageSchema,
  PageInfoSchema,
  PublicErrorCodeSchema,
  SafeErrorSchema,
  SightingsQuerySchema,
  SightingSchema,
  WhaleTrackSchema,
  WhaleSchema,
  WhalesQuerySchema,
  ExternalSightingSchema,
  IdentifyResponseSchema,
  PredictionSchema,
  SubmitSightingPayloadSchema,
  WhaleProfileSchema,
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

  it('accepts the exact Apple exchange and response contracts', () => {
    const nonce = 'n'.repeat(64);
    const csrfToken = 'c'.repeat(64);

    expect(AuthAppleRequestSchema.parse({
      authorizationCode: 'single-use-code',
      fullName: 'Casey Morgan',
      identityToken: 'header.payload.signature',
      nonce,
    })).toMatchObject({ nonce });
    expect(AuthAppleResponseSchema.parse({
      csrfToken,
      user: {
        displayName: 'Casey Morgan',
        email: 'relay@example.com',
        id: 'user-1',
        role: 'OBSERVER',
      },
    }).user.role).toBe('OBSERVER');

    expect(AuthAppleRequestSchema.safeParse({
      identityToken: 'header.payload.signature',
      nonce,
    }).success).toBe(false);
    expect(AuthAppleRequestSchema.safeParse({
      authorizationCode: 'single-use-code',
      identityToken: 'header.payload.signature',
    }).success).toBe(false);
    expect(AuthAppleRequestSchema.safeParse({
      authorizationCode: 'single-use-code',
      identityToken: 'header.payload.signature',
      nonce,
      unexpected: true,
    }).success).toBe(false);
  });

  it('requires a UUID idempotency key and rejects unknown submission fields', () => {
    const basePayload = {
      clientSubmissionId: 'e0f59404-ded3-4a07-8b3e-247ec89adcf7',
      observedAt: '2026-07-16T18:00:00.000Z',
      latitude: 48.5,
      longitude: -123.25,
      observerEmail: 'observer@example.com',
    } as const;

    expect(SubmitSightingPayloadSchema.safeParse({
      ...basePayload,
      clientSubmissionId: 'not-a-uuid',
    }).success).toBe(false);
    expect(SubmitSightingPayloadSchema.safeParse({
      ...basePayload,
      futureClientField: true,
    }).success).toBe(false);
    expect(SubmitSightingPayloadSchema.safeParse(basePayload).success).toBe(true);
  });

  it('never exposes observer email in Logbook rows and bounds pages', () => {
    const item = {
      behaviorNotes: null,
      createdAt: '2026-07-17T12:01:00.000Z',
      ecotypeGuess: null,
      groupSize: null,
      id: 'sighting-1',
      latitude: 48.5,
      locationName: null,
      longitude: -123,
      observedAt: '2026-07-17T12:00:00.000Z',
      photoCount: 0,
      rejectionReason: null,
      status: 'PENDING',
    } as const;
    const page = { hasMore: false, nextCursor: null } as const;
    const parsed = MySightingPageSchema.parse({ items: [item], page });

    expect(parsed.items[0]).not.toHaveProperty('observerEmail');
    expect(MySightingPageSchema.safeParse({
      items: [{ ...item, observerEmail: 'observer@example.com' }],
      page,
    }).success).toBe(false);
    expect(MySightingPageSchema.safeParse({
      items: Array.from({ length: 101 }, () => item),
      page,
    }).success).toBe(false);
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

  it('rejects empty stable identifiers in public list records', () => {
    const whale = {
      biography: null,
      birthYear: null,
      catalogId: 'FX-001',
      deathYear: null,
      distinguishingMarks: null,
      ecotype: 'UNKNOWN',
      heroImageUrl: null,
      id: '',
      name: null,
      notableEvents: [],
      pod: null,
      sex: 'UNKNOWN',
      sourceCitations: [],
      status: 'UNKNOWN',
    };
    expect(WhaleSchema.safeParse(whale).success).toBe(false);

    const sighting = {
      behaviorNotes: null,
      ecotypeGuess: null,
      groupSize: null,
      id: '',
      identifiedWhales: [],
      latitude: 48.5,
      locationName: null,
      longitude: -123.25,
      observedAt: '2026-07-16T18:00:00.000Z',
      photoUrls: [],
      photos: [],
      status: 'APPROVED',
    };
    expect(SightingSchema.safeParse(sighting).success).toBe(false);
  });

  it('keeps the retained identify artifact scheme-safe and nonempty', () => {
    const identify = {
      confidenceBand: 'high',
      indexVersion: 'fixture-index-v1',
      matches: [{
        catalogId: '',
        explanation: 'Synthetic explanation.',
        matchedReferencePhotoIds: [''],
        name: null,
        rank: 1,
        score: 0.9,
      }],
      model: 'fixture-model-v1',
      uploadUrl: 'ftp://fixtures.invalid/upload.jpg',
    };

    expect(IdentifyResponseSchema.safeParse(identify).success).toBe(false);
  });

  it('enforces the shared Release A scalar bounds', () => {
    const maximumURL = 'https://fixtures.invalid/'.padEnd(2_048, 'a');
    const whale = {
      biography: 'a'.repeat(20_000),
      birthYear: 1000,
      catalogId: 'FX-001',
      deathYear: 9999,
      distinguishingMarks: null,
      ecotype: 'UNKNOWN',
      heroImageUrl: maximumURL,
      id: 'fixture-whale',
      name: null,
      notableEvents: [],
      pod: null,
      sex: 'UNKNOWN',
      sourceCitations: [],
      status: 'DECEASED',
    };
    const sighting = {
      behaviorNotes: null,
      ecotypeGuess: null,
      groupSize: 200,
      id: 'fixture-sighting',
      identifiedWhales: [],
      latitude: 48.5,
      locationName: null,
      longitude: -123.25,
      observedAt: '2026-07-16T18:00:00.000Z',
      photoUrls: [],
      photos: [],
      status: 'APPROVED',
    };

    expect(WhaleSchema.safeParse(whale).success).toBe(true);
    expect(SightingSchema.safeParse(sighting).success).toBe(true);
    expect(WhaleSchema.safeParse({ ...whale, biography: 'a'.repeat(20_001) }).success).toBe(false);
    expect(WhaleSchema.safeParse({ ...whale, birthYear: 999 }).success).toBe(false);
    expect(WhaleSchema.safeParse({ ...whale, deathYear: 10_000 }).success).toBe(false);
    expect(WhaleSchema.safeParse({ ...whale, heroImageUrl: `${maximumURL}a` }).success).toBe(false);
    expect(SightingSchema.safeParse({ ...sighting, groupSize: 0 }).success).toBe(false);
    expect(SightingSchema.safeParse({ ...sighting, groupSize: 201 }).success).toBe(false);
  });

  it('enforces the shared Release A nested cardinality bound', () => {
    const citation = { label: 'Fixture citation', url: 'https://fixtures.invalid/source' };
    const whale = {
      biography: null,
      birthYear: null,
      catalogId: 'FX-001',
      deathYear: null,
      distinguishingMarks: null,
      ecotype: 'UNKNOWN',
      heroImageUrl: null,
      id: 'fixture-whale',
      name: null,
      notableEvents: [],
      pod: null,
      sex: 'UNKNOWN',
      sourceCitations: Array.from({ length: 1_000 }, () => citation),
      status: 'UNKNOWN',
    };

    expect(WhaleSchema.safeParse(whale).success).toBe(true);
    expect(WhaleSchema.safeParse({
      ...whale,
      sourceCitations: [...whale.sourceCitations, citation],
    }).success).toBe(false);
  });
});
