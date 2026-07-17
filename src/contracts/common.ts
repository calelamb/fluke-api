import { z } from 'zod';

export const MAX_ID_LENGTH = 200;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_URL_LENGTH = 2_048;
export const MAX_NESTED_ITEMS = 1_000;
export const MIN_YEAR = 1_000;
export const MAX_YEAR = 9_999;
export const MIN_GROUP_SIZE = 1;
export const MAX_GROUP_SIZE = 200;

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const LatitudeSchema = z.number().finite().min(-90).max(90);
export const LongitudeSchema = z.number().finite().min(-180).max(180);
export const ProbabilitySchema = z.number().finite().min(0).max(1);
export const BoundedTextSchema = z.string().max(MAX_TEXT_LENGTH);
export const YearSchema = z.number().int().min(MIN_YEAR).max(MAX_YEAR);
export const GroupSizeSchema = z.number().int().min(MIN_GROUP_SIZE).max(MAX_GROUP_SIZE);
export const HttpUrlSchema = z.string()
  .max(MAX_URL_LENGTH)
  .url()
  .regex(/^https?:\/\//, 'URL must use http or https');
export const StableIdSchema = z.string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/\S/, 'ID must contain a non-whitespace character');
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
