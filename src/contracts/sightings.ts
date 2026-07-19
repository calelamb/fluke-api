import { z } from 'zod';
import { MAX_EXTERNAL_PUBLIC_FEED_ID_LENGTH } from '../lib/public-feed-id.js';
import {
  BoundedTextSchema,
  CursorSchema,
  EcotypeSchema,
  GroupSizeSchema,
  HttpUrlSchema,
  IdConfidenceSchema,
  IsoDateTimeSchema,
  LatitudeSchema,
  LongitudeSchema,
  MAX_NESTED_ITEMS,
  PageInfoSchema,
  PodSchema,
  StableIdSchema,
  SightingStatusSchema,
} from './common.js';

export const SightingPhotoSchema = z.object({
  id: StableIdSchema,
  url: HttpUrlSchema,
  thumbnailUrl: HttpUrlSchema,
  orderIndex: z.number().int(),
});

const IdentifiedWhaleSchema = z.object({
  catalogId: StableIdSchema,
  name: BoundedTextSchema.nullable(),
  confidence: IdConfidenceSchema,
});

const PublicFeedIdSchema = z.string()
  .min(1)
  .max(MAX_EXTERNAL_PUBLIC_FEED_ID_LENGTH)
  .regex(/\S/u);
const PublicFeedRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const InternalSightingFeedItemSchema = z.object({
  behaviorNotes: BoundedTextSchema.nullable(),
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: GroupSizeSchema.nullable(),
  id: PublicFeedIdSchema,
  identifiedWhales: z.array(IdentifiedWhaleSchema).max(MAX_NESTED_ITEMS),
  kind: z.literal('internal'),
  latitude: LatitudeSchema,
  locationName: BoundedTextSchema.nullable(),
  longitude: LongitudeSchema,
  observedAt: IsoDateTimeSchema,
  photos: z.array(SightingPhotoSchema).max(MAX_NESTED_ITEMS),
  revision: PublicFeedRevisionSchema,
}).strict();

export const ExternalSightingFeedItemSchema = z.object({
  attribution: BoundedTextSchema,
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: GroupSizeSchema.nullable(),
  id: PublicFeedIdSchema,
  kind: z.literal('external'),
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  notes: BoundedTextSchema.nullable(),
  observedAt: IsoDateTimeSchema,
  revision: PublicFeedRevisionSchema,
  source: BoundedTextSchema,
  sourceUrl: HttpUrlSchema.nullable(),
  species: BoundedTextSchema,
  trusted: z.boolean(),
}).strict();

export const RemovedSightingFeedItemSchema = z.object({
  id: PublicFeedIdSchema,
  kind: z.literal('removed'),
  revision: PublicFeedRevisionSchema,
}).strict();

export const SightingFeedItemSchema = z.discriminatedUnion('kind', [
  InternalSightingFeedItemSchema,
  ExternalSightingFeedItemSchema,
  RemovedSightingFeedItemSchema,
]);

export const ProviderFreshnessSchema = z.object({
  expectedMaximumLag: z.number().int().positive().max(31 * 24 * 60 * 60),
  lastAttemptAt: IsoDateTimeSchema.nullable(),
  lastSuccessAt: IsoDateTimeSchema.nullable(),
  provider: z.enum(['acartia', 'gbif']),
  status: z.enum([
    'NEVER_RUN',
    'STARTED',
    'SUCCEEDED',
    'FAILED',
    'SKIPPED_LOCKED',
    'LEASE_LOST',
  ]),
}).strict();

export const SightingFeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  pageCursor: CursorSchema.optional(),
  syncCursor: CursorSchema.optional(),
}).strict().refine((value) => !(value.pageCursor && value.syncCursor), {
  message: 'pageCursor and syncCursor are mutually exclusive',
});

export const SightingFeedPageSchema = z.object({
  hasMore: z.boolean(),
  items: z.array(SightingFeedItemSchema).max(100),
  pageCursor: CursorSchema.nullable(),
  providers: z.array(ProviderFreshnessSchema).length(2),
  syncCursor: CursorSchema,
}).strict();

export const LocalIdentificationSuggestionSchema = z.object({
  catalogId: StableIdSchema,
  similarityScore: z.number().finite().min(-1).max(1),
  scoreSemantics: z.literal('uncalibrated_similarity_not_probability'),
  manifestVersion: StableIdSchema,
  modelVersion: StableIdSchema,
  indexVersion: StableIdSchema,
  matchedReferencePhotoIds: z.array(StableIdSchema).max(5),
}).strict().superRefine((value, context) => {
  if (new Set(value.matchedReferencePhotoIds).size !== value.matchedReferencePhotoIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'matched reference photo IDs must be unique',
      path: ['matchedReferencePhotoIds'],
    });
  }
});

export const SightingSchema = z.object({
  id: StableIdSchema,
  observedAt: IsoDateTimeSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  locationName: BoundedTextSchema.nullable(),
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: GroupSizeSchema.nullable(),
  behaviorNotes: BoundedTextSchema.nullable(),
  status: SightingStatusSchema,
  photoUrls: z.array(HttpUrlSchema).max(MAX_NESTED_ITEMS),
  photos: z.array(SightingPhotoSchema).max(MAX_NESTED_ITEMS),
  identifiedWhales: z.array(IdentifiedWhaleSchema).max(MAX_NESTED_ITEMS),
});

export const PendingSightingSchema = z.object({
  id: z.string(),
  observedAt: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  locationName: z.string().nullable(),
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: z.number().int().nullable(),
  behaviorNotes: z.string().nullable(),
  observerName: z.string().nullable(),
  observerEmail: z.string(),
  status: SightingStatusSchema,
  createdAt: z.string(),
  identifiedWhales: z.array(IdentifiedWhaleSchema),
  photos: z.array(SightingPhotoSchema),
});

export const SubmitSightingPayloadSchema = z.object({
  clientSubmissionId: z.string().uuid(),
  observedAt: z.string().datetime(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  locationName: z.string().max(200).nullable().optional(),
  ecotypeGuess: EcotypeSchema.nullable().optional(),
  groupSize: z.number().int().min(1).max(100).nullable().optional(),
  behaviorNotes: z.string().max(2000).nullable().optional(),
  observerName: z.string().max(120).nullable().optional(),
  observerEmail: z.string().email().max(200),
  localIdentification: LocalIdentificationSuggestionSchema.optional(),
}).strict();

export const MySightingSchema = z.object({
  behaviorNotes: BoundedTextSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: GroupSizeSchema.nullable(),
  id: StableIdSchema,
  latitude: LatitudeSchema,
  locationName: BoundedTextSchema.nullable(),
  longitude: LongitudeSchema,
  observedAt: IsoDateTimeSchema,
  photoCount: z.number().int().min(0).max(MAX_NESTED_ITEMS),
  rejectionReason: BoundedTextSchema.nullable(),
  status: SightingStatusSchema,
}).strict();

export const MySightingPageSchema = z.object({
  items: z.array(MySightingSchema).max(100),
  page: PageInfoSchema,
}).strict();

export const SubmitSightingResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  identificationSuggestionId: z.string().nullable(),
  photoUploadToken: z.string(),
}).strict();

export const ExternalSightingSchema = z.object({
  id: StableIdSchema,
  source: BoundedTextSchema,
  externalId: StableIdSchema,
  observedAt: IsoDateTimeSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  species: BoundedTextSchema,
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: GroupSizeSchema.nullable(),
  attribution: BoundedTextSchema,
  sourceUrl: HttpUrlSchema.nullable(),
  notes: BoundedTextSchema.nullable(),
  trusted: z.boolean(),
});

export const HistoricalSightingSchema = z.object({
  id: StableIdSchema,
  observedAt: IsoDateTimeSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  locationName: BoundedTextSchema.nullable(),
  ecotypeGuess: EcotypeSchema.nullable(),
  whaleIds: z.array(StableIdSchema).max(MAX_NESTED_ITEMS),
});

export const SightingsQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const ExternalSightingsQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sinceDays: z.coerce.number().int().min(1).max(31).default(7),
  source: z.string().min(1).max(100).optional(),
}).strict();

export const HistoricalSightingsQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  pod: PodSchema.optional(),
  to: IsoDateTimeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.from) !== Boolean(value.to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'from and to must be provided together',
      path: value.from ? ['to'] : ['from'],
    });
    return;
  }
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'from must be before or equal to to',
      path: ['from'],
    });
  }
  const maximumWindowMs = 366 * 24 * 60 * 60 * 1000;
  if (value.from && value.to && Date.parse(value.to) - Date.parse(value.from) > maximumWindowMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'date window must not exceed 366 days',
      path: ['to'],
    });
  }
});

export const SightingPageSchema = z.object({
  items: z.array(SightingSchema).max(100),
  page: PageInfoSchema,
}).strict();

export const ExternalSightingPageSchema = z.object({
  items: z.array(ExternalSightingSchema).max(100),
  page: PageInfoSchema,
}).strict();

export const HistoricalSightingPageSchema = z.object({
  items: z.array(HistoricalSightingSchema).max(100),
  page: PageInfoSchema,
}).strict();

export type SightingPhotoDTO = z.infer<typeof SightingPhotoSchema>;
export type SightingDTO = z.infer<typeof SightingSchema>;
export type PendingSightingDTO = z.infer<typeof PendingSightingSchema>;
export type SubmitSightingPayload = z.infer<typeof SubmitSightingPayloadSchema>;
export type SubmitSightingResponse = z.infer<typeof SubmitSightingResponseSchema>;
export type LocalIdentificationSuggestion = z.infer<typeof LocalIdentificationSuggestionSchema>;
export type MySighting = z.infer<typeof MySightingSchema>;
export type MySightingPage = z.infer<typeof MySightingPageSchema>;
export type ExternalSightingDTO = z.infer<typeof ExternalSightingSchema>;
export type HistoricalSighting = z.infer<typeof HistoricalSightingSchema>;
export type SightingPage = z.infer<typeof SightingPageSchema>;
export type ExternalSightingPage = z.infer<typeof ExternalSightingPageSchema>;
export type HistoricalSightingPage = z.infer<typeof HistoricalSightingPageSchema>;
export type SightingFeedItem = z.infer<typeof SightingFeedItemSchema>;
export type SightingFeedPage = z.infer<typeof SightingFeedPageSchema>;
export type ProviderFreshness = z.infer<typeof ProviderFreshnessSchema>;
