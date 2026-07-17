import { z, type ZodType } from 'zod';
import {
  CapabilitiesSchema,
  ExternalSightingSchema,
  HistoricalSightingSchema,
  IdentifyResponseSchema,
  PredictionSchema,
  RELEASE_A_CAPABILITIES,
  SafeErrorSchema,
  SightingSchema,
  WhaleProfileSchema,
  WhaleSchema,
} from '../src/contracts/index.js';

export interface ContractDefinition {
  readonly fixture: unknown;
  readonly jsonSchemaTitle: string;
  readonly name: string;
  readonly schema: ZodType;
}

const FIXTURE_TIMESTAMP = '2026-07-16T18:00:00.000Z';

const HealthSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.string().datetime(),
});

const whaleFixture = {
  biography: 'Synthetic biography for contract testing only.',
  birthYear: 2000,
  catalogId: 'FX-001',
  deathYear: null,
  distinguishingMarks: 'Synthetic distinguishing marks.',
  ecotype: 'UNKNOWN',
  heroImageUrl: 'https://fixtures.invalid/whales/fixture-alpha.jpg',
  id: 'fixture-whale-alpha',
  name: 'Fixture Whale Alpha',
  notableEvents: [
    {
      date: '2024-01-15',
      source: 'Synthetic Fixture Source',
      summary: 'Synthetic milestone for contract testing.',
      type: 'milestone',
      year: 2024,
    },
  ],
  pod: 'FIXTURE_POD',
  sex: 'FEMALE',
  sourceCitations: [
    {
      label: 'Synthetic Fixture Citation',
      url: 'https://fixtures.invalid/sources/synthetic',
    },
  ],
  status: 'ALIVE',
} as const;

const whaleDetailFixture = {
  ...whaleFixture,
  mother: {
    catalogId: 'FX-000',
    name: 'Fixture Whale Parent',
  },
  offspring: [
    {
      catalogId: 'FX-002',
      name: 'Fixture Whale Offspring',
    },
  ],
  recentSightings: [
    {
      id: 'fixture-sighting-1',
      latitude: 12.345,
      locationName: 'Fixture Strait',
      longitude: -45.678,
      observedAt: FIXTURE_TIMESTAMP,
    },
  ],
} as const;

const sightingFixture = {
  behaviorNotes: 'Synthetic travel notes for contract testing.',
  ecotypeGuess: 'UNKNOWN',
  groupSize: 4,
  id: 'fixture-sighting-1',
  identifiedWhales: [
    {
      catalogId: 'FX-001',
      confidence: 'CONFIRMED',
      name: 'Fixture Whale Alpha',
    },
  ],
  latitude: 12.345,
  locationName: 'Fixture Strait',
  longitude: -45.678,
  observedAt: FIXTURE_TIMESTAMP,
  photos: [
    {
      id: 'fixture-photo-1',
      orderIndex: 0,
      thumbnailUrl: 'https://fixtures.invalid/sightings/fixture-thumb.jpg',
      url: 'https://fixtures.invalid/sightings/fixture.jpg',
    },
  ],
  photoUrls: ['https://fixtures.invalid/sightings/fixture.jpg'],
  status: 'APPROVED',
} as const;

const fixtures = {
  capabilities: {
    ...RELEASE_A_CAPABILITIES,
  },
  'external-sightings': [
    {
      attribution: 'Synthetic fixture feed',
      ecotypeGuess: 'UNKNOWN',
      externalId: 'fixture-observation-1',
      groupSize: 3,
      id: 'external-sighting-1',
      latitude: 23.456,
      longitude: -56.789,
      notes: 'Synthetic observation for contract testing.',
      observedAt: FIXTURE_TIMESTAMP,
      source: 'fixture-feed',
      sourceUrl: 'https://fixtures.invalid/observations/1',
      species: 'Orcinus orca',
      trusted: true,
    },
  ],
  health: {
    status: 'ok',
    timestamp: FIXTURE_TIMESTAMP,
  },
  'historical-sightings': [
    {
      ecotypeGuess: 'UNKNOWN',
      id: 'historical-sighting-1',
      latitude: 12.345,
      locationName: 'Fixture Strait',
      longitude: -45.678,
      observedAt: '2025-07-16T18:00:00.000Z',
      whaleIds: ['fixture-whale-alpha'],
    },
  ],
  identify: {
    confidenceBand: 'high',
    indexVersion: 'fixture-index-v1',
    matches: [
      {
        catalogId: 'FX-001',
        explanation: 'Synthetic image features match the fixture reference.',
        matchedReferencePhotoIds: ['fixture-reference-alpha'],
        name: 'Fixture Whale Alpha',
        rank: 1,
        score: 0.94,
      },
    ],
    model: 'fixture-identifier-v1',
    uploadUrl: 'https://fixtures.invalid/identify/upload-1.jpg',
  },
  prediction: {
    cells: [
      {
        lat: 34.567,
        lng: -67.89,
        probability: 0.72,
      },
    ],
    computedAt: FIXTURE_TIMESTAMP,
    confidence: 0.68,
    modelVersion: 'fixture-prediction-v1',
  },
  'safe-error': {
    error: 'Requested fixture resource was not found.',
  },
  sightings: [sightingFixture],
  'whale-detail': whaleDetailFixture,
  whales: [whaleFixture],
} as const;

export const contractDefinitions: readonly ContractDefinition[] = [
  {
    fixture: fixtures.capabilities,
    jsonSchemaTitle: 'Capabilities',
    name: 'capabilities',
    schema: CapabilitiesSchema,
  },
  {
    fixture: fixtures['external-sightings'],
    jsonSchemaTitle: 'ExternalSightings',
    name: 'external-sightings',
    schema: z.array(ExternalSightingSchema),
  },
  {
    fixture: fixtures.health,
    jsonSchemaTitle: 'Health',
    name: 'health',
    schema: HealthSchema,
  },
  {
    fixture: fixtures['historical-sightings'],
    jsonSchemaTitle: 'HistoricalSightings',
    name: 'historical-sightings',
    schema: z.array(HistoricalSightingSchema),
  },
  {
    fixture: fixtures.identify,
    jsonSchemaTitle: 'Identify',
    name: 'identify',
    schema: IdentifyResponseSchema,
  },
  {
    fixture: fixtures.prediction,
    jsonSchemaTitle: 'Prediction',
    name: 'prediction',
    schema: PredictionSchema,
  },
  {
    fixture: fixtures['safe-error'],
    jsonSchemaTitle: 'SafeError',
    name: 'safe-error',
    schema: SafeErrorSchema,
  },
  {
    fixture: fixtures.sightings,
    jsonSchemaTitle: 'Sightings',
    name: 'sightings',
    schema: z.array(SightingSchema),
  },
  {
    fixture: fixtures['whale-detail'],
    jsonSchemaTitle: 'WhaleDetail',
    name: 'whale-detail',
    schema: WhaleProfileSchema,
  },
  {
    fixture: fixtures.whales,
    jsonSchemaTitle: 'Whales',
    name: 'whales',
    schema: z.array(WhaleSchema),
  },
];
