import { z, type ZodType } from 'zod';
import {
  ExternalSightingSchema,
  HistoricalSightingSchema,
  IdentifyResponseSchema,
  PredictionSchema,
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

const CapabilitiesSchema = z.object({
  accounts: z.boolean(),
  identification: z.boolean(),
  submissions: z.boolean(),
});

const SafeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1),
  retryable: z.boolean(),
});

const whaleFixture = {
  biography: 'A well-documented member of J pod.',
  birthYear: 1998,
  catalogId: 'J35',
  deathYear: null,
  distinguishingMarks: 'Distinctive dorsal fin and saddle patch.',
  ecotype: 'RESIDENT',
  heroImageUrl: 'https://fixtures.fluke.test/whales/j35.jpg',
  id: 'whale-j35',
  name: 'Tahlequah',
  notableEvents: [
    {
      date: '2020-09-05',
      source: 'Center for Whale Research',
      summary: 'Observed traveling with a healthy calf.',
      type: 'birth',
      year: 2020,
    },
  ],
  pod: 'J',
  sex: 'FEMALE',
  sourceCitations: [
    {
      label: 'Orca Survey',
      url: 'https://fixtures.fluke.test/sources/orca-survey',
    },
  ],
  status: 'ALIVE',
} as const;

const whaleDetailFixture = {
  ...whaleFixture,
  mother: {
    catalogId: 'J17',
    name: 'Princess Angeline',
  },
  offspring: [
    {
      catalogId: 'J57',
      name: 'Phoenix',
    },
  ],
  recentSightings: [
    {
      id: 'sighting-salish-sea',
      latitude: 48.516,
      locationName: 'Salish Sea',
      longitude: -123.152,
      observedAt: FIXTURE_TIMESTAMP,
    },
  ],
} as const;

const sightingFixture = {
  behaviorNotes: 'Traveling north in a close group.',
  ecotypeGuess: 'RESIDENT',
  groupSize: 4,
  id: 'sighting-salish-sea',
  identifiedWhales: [
    {
      catalogId: 'J35',
      confidence: 'CONFIRMED',
      name: 'Tahlequah',
    },
  ],
  latitude: 48.516,
  locationName: 'Salish Sea',
  longitude: -123.152,
  observedAt: FIXTURE_TIMESTAMP,
  photos: [
    {
      id: 'photo-salish-sea-1',
      orderIndex: 0,
      thumbnailUrl: 'https://fixtures.fluke.test/sightings/salish-sea-thumb.jpg',
      url: 'https://fixtures.fluke.test/sightings/salish-sea.jpg',
    },
  ],
  photoUrls: ['https://fixtures.fluke.test/sightings/salish-sea.jpg'],
  status: 'APPROVED',
} as const;

const fixtures = {
  capabilities: {
    accounts: false,
    identification: false,
    submissions: false,
  },
  'external-sightings': [
    {
      attribution: 'Fixture research feed',
      ecotypeGuess: 'BIGGS',
      externalId: 'fixture-observation-1',
      groupSize: 3,
      id: 'external-sighting-1',
      latitude: 48.62,
      longitude: -123.31,
      notes: 'Public research observation.',
      observedAt: FIXTURE_TIMESTAMP,
      source: 'fixture-feed',
      sourceUrl: 'https://fixtures.fluke.test/observations/1',
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
      ecotypeGuess: 'RESIDENT',
      id: 'historical-sighting-1',
      latitude: 48.516,
      locationName: 'Salish Sea',
      longitude: -123.152,
      observedAt: '2025-07-16T18:00:00.000Z',
      whaleIds: ['whale-j35'],
    },
  ],
  identify: {
    confidenceBand: 'high',
    indexVersion: 'fixture-index-v1',
    matches: [
      {
        catalogId: 'J35',
        explanation: 'Dorsal fin and saddle patch features are consistent.',
        matchedReferencePhotoIds: ['reference-j35-left'],
        name: 'Tahlequah',
        rank: 1,
        score: 0.94,
      },
    ],
    model: 'fixture-identifier-v1',
    uploadUrl: 'https://fixtures.fluke.test/identify/upload-1.jpg',
  },
  prediction: {
    cells: [
      {
        lat: 48.5,
        lng: -123.2,
        probability: 0.72,
      },
    ],
    computedAt: FIXTURE_TIMESTAMP,
    confidence: 0.68,
    modelVersion: 'fixture-prediction-v1',
  },
  'safe-error': {
    code: 'WHALE_NOT_FOUND',
    message: 'Whale not found.',
    requestId: 'request-contract-fixture',
    retryable: false,
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
