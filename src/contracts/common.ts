import { z } from 'zod';

export const EcotypeSchema = z.enum(['RESIDENT', 'BIGGS', 'OFFSHORE', 'UNKNOWN']);
export const SexSchema = z.enum(['MALE', 'FEMALE', 'UNKNOWN']);
export const WhaleStatusSchema = z.enum(['ALIVE', 'DECEASED', 'UNKNOWN']);
export const SightingStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export const IdConfidenceSchema = z.enum(['CONFIRMED', 'LIKELY', 'ML_SUGGESTED']);
export const PhotoQualitySchema = z.enum([
  'USABLE',
  'OCCLUDED',
  'MOTION_BLUR',
  'WRONG_ANGLE',
  'TOO_DISTANT',
  'NOT_ORCA',
]);
export const ReferencePhotoSideSchema = z.enum(['LEFT', 'RIGHT', 'UNKNOWN']);
export const EmbeddingStatusSchema = z.enum(['PENDING', 'EMBEDDED', 'FAILED']);
export const PodSchema = z.enum(['J', 'K', 'L', 'BIGGS']);

export type Ecotype = z.infer<typeof EcotypeSchema>;
export type Sex = z.infer<typeof SexSchema>;
export type WhaleStatus = z.infer<typeof WhaleStatusSchema>;
export type SightingStatus = z.infer<typeof SightingStatusSchema>;
export type IdConfidence = z.infer<typeof IdConfidenceSchema>;
export type PhotoQuality = z.infer<typeof PhotoQualitySchema>;
export type ReferencePhotoSide = z.infer<typeof ReferencePhotoSideSchema>;
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;
export type Pod = z.infer<typeof PodSchema>;
