import { z } from 'zod';
import {
  EmbeddingStatusSchema,
  IdConfidenceSchema,
  PhotoQualitySchema,
  ReferencePhotoSideSchema,
} from './common.js';

export const LABEL_PHOTO_AUDIT_ACTION = 'LABEL_PHOTO' as const;

export const PhotoAnnotationBoxSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});

export const PhotoAnnotationPayloadSchema = z.object({
  dorsal_fin: PhotoAnnotationBoxSchema.optional(),
  saddle_patch: PhotoAnnotationBoxSchema.optional(),
});

export const AnnotatePhotoBodySchema = z.object({
  quality: PhotoQualitySchema,
  whaleCatalogId: z.string().min(1).optional().nullable(),
  confidence: IdConfidenceSchema.optional().nullable(),
  payload: PhotoAnnotationPayloadSchema.optional(),
  notes: z.string().max(500).optional().nullable(),
  done: z.boolean().optional(),
});

export const PhotoAnnotationSchema = z.object({
  id: z.string(),
  photoId: z.string(),
  version: z.number().int(),
  quality: PhotoQualitySchema,
  whaleCatalogId: z.string().nullable(),
  whaleName: z.string().nullable(),
  confidence: IdConfidenceSchema.nullable(),
  payload: PhotoAnnotationPayloadSchema,
  notes: z.string().nullable(),
  done: z.boolean(),
  labeledById: z.string(),
  labeledAt: z.string(),
});

export const LabelablePhotoSchema = z.object({
  id: z.string(),
  url: z.string(),
  thumbnailUrl: z.string(),
  orderIndex: z.number().int(),
  done: z.boolean(),
  createdAt: z.string(),
  sighting: z.object({
    id: z.string(),
    observedAt: z.string(),
    locationName: z.string().nullable(),
    observerEmail: z.string(),
  }),
  latestAnnotation: PhotoAnnotationSchema.nullable(),
});

export const WhaleReferencePhotoSchema = z.object({
  id: z.string(),
  whaleId: z.string(),
  catalogId: z.string(),
  whaleName: z.string().nullable(),
  url: z.string(),
  side: ReferencePhotoSideSchema,
  quality: PhotoQualitySchema,
  cropX: z.number().nullable(),
  cropY: z.number().nullable(),
  cropWidth: z.number().nullable(),
  cropHeight: z.number().nullable(),
  embeddingStatus: EmbeddingStatusSchema,
  notes: z.string().nullable(),
  createdAt: z.string(),
});

export type PhotoAnnotationBox = z.infer<typeof PhotoAnnotationBoxSchema>;
export type PhotoAnnotationPayload = z.infer<typeof PhotoAnnotationPayloadSchema>;
export type PhotoAnnotationDTO = z.infer<typeof PhotoAnnotationSchema>;
export type LabelablePhotoDTO = z.infer<typeof LabelablePhotoSchema>;
export type WhaleReferencePhotoDTO = z.infer<typeof WhaleReferencePhotoSchema>;
