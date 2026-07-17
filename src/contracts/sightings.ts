import { z } from 'zod';
import {
  CursorSchema,
  EcotypeSchema,
  HttpUrlSchema,
  IdConfidenceSchema,
  IsoDateTimeSchema,
  LatitudeSchema,
  LongitudeSchema,
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
  name: z.string().nullable(),
  confidence: IdConfidenceSchema,
});

export const SightingSchema = z.object({
  id: StableIdSchema,
  observedAt: IsoDateTimeSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  locationName: z.string().nullable(),
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: z.number().int().nullable(),
  behaviorNotes: z.string().nullable(),
  status: SightingStatusSchema,
  photoUrls: z.array(HttpUrlSchema),
  photos: z.array(SightingPhotoSchema),
  identifiedWhales: z.array(IdentifiedWhaleSchema),
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
  observedAt: z.string().datetime(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  locationName: z.string().max(200).nullable().optional(),
  ecotypeGuess: EcotypeSchema.nullable().optional(),
  groupSize: z.number().int().min(1).max(100).nullable().optional(),
  behaviorNotes: z.string().max(2000).nullable().optional(),
  observerName: z.string().max(120).nullable().optional(),
  observerEmail: z.string().email().max(200),
});

export const SubmitSightingResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  photoUploadToken: z.string(),
});

export const ExternalSightingSchema = z.object({
  id: StableIdSchema,
  source: z.string(),
  externalId: StableIdSchema,
  observedAt: IsoDateTimeSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  species: z.string(),
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: z.number().int().nullable(),
  attribution: z.string(),
  sourceUrl: HttpUrlSchema.nullable(),
  notes: z.string().nullable(),
  trusted: z.boolean(),
});

export const HistoricalSightingSchema = z.object({
  id: StableIdSchema,
  observedAt: IsoDateTimeSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  locationName: z.string().nullable(),
  ecotypeGuess: EcotypeSchema.nullable(),
  whaleIds: z.array(StableIdSchema),
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
export type ExternalSightingDTO = z.infer<typeof ExternalSightingSchema>;
export type HistoricalSighting = z.infer<typeof HistoricalSightingSchema>;
export type SightingPage = z.infer<typeof SightingPageSchema>;
export type ExternalSightingPage = z.infer<typeof ExternalSightingPageSchema>;
export type HistoricalSightingPage = z.infer<typeof HistoricalSightingPageSchema>;
