import { z } from 'zod';

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const LatitudeSchema = z.number().finite().min(-90).max(90);
export const LongitudeSchema = z.number().finite().min(-180).max(180);
export const ProbabilitySchema = z.number().finite().min(0).max(1);
export const HttpUrlSchema = z.string().url().regex(/^https?:\/\//, 'URL must use http or https');
export const StableIdSchema = z.string().min(1).max(200);
export const CursorSchema = z.string().min(1).max(512);
export const PageInfoSchema = z.discriminatedUnion('hasMore', [
  z.object({
    hasMore: z.literal(true),
    nextCursor: CursorSchema,
  }).strict(),
  z.object({
    hasMore: z.literal(false),
    nextCursor: z.null(),
  }).strict(),
]);

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
export type PageInfo = z.infer<typeof PageInfoSchema>;
