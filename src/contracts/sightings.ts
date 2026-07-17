import { z } from 'zod';
import {
  EcotypeSchema,
  IdConfidenceSchema,
  SightingStatusSchema,
} from './common.js';

export const SightingPhotoSchema = z.object({
  id: z.string(),
  url: z.string(),
  thumbnailUrl: z.string(),
  orderIndex: z.number().int(),
});

const IdentifiedWhaleSchema = z.object({
  catalogId: z.string(),
  name: z.string().nullable(),
  confidence: IdConfidenceSchema,
});

export const SightingSchema = z.object({
  id: z.string(),
  observedAt: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  locationName: z.string().nullable(),
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: z.number().int().nullable(),
  behaviorNotes: z.string().nullable(),
  status: SightingStatusSchema,
  photoUrls: z.array(z.string()),
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
  id: z.string(),
  source: z.string(),
  externalId: z.string(),
  observedAt: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  species: z.string(),
  ecotypeGuess: EcotypeSchema.nullable(),
  groupSize: z.number().int().nullable(),
  attribution: z.string(),
  sourceUrl: z.string().nullable(),
  notes: z.string().nullable(),
  trusted: z.boolean(),
});

export const HistoricalSightingSchema = z.object({
  id: z.string(),
  observedAt: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  locationName: z.string().nullable(),
  ecotypeGuess: EcotypeSchema.nullable(),
  whaleIds: z.array(z.string()),
});

export type SightingPhotoDTO = z.infer<typeof SightingPhotoSchema>;
export type SightingDTO = z.infer<typeof SightingSchema>;
export type PendingSightingDTO = z.infer<typeof PendingSightingSchema>;
export type SubmitSightingPayload = z.infer<typeof SubmitSightingPayloadSchema>;
export type SubmitSightingResponse = z.infer<typeof SubmitSightingResponseSchema>;
export type ExternalSightingDTO = z.infer<typeof ExternalSightingSchema>;
export type HistoricalSighting = z.infer<typeof HistoricalSightingSchema>;
