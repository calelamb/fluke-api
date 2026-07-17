import { z } from 'zod';
import { HttpUrlSchema, ProbabilitySchema, StableIdSchema } from './common.js';

export const IdentifyConfidenceBandSchema = z.enum([
  'high',
  'medium',
  'low',
  'unavailable',
]);

export const IdentifyMatchSchema = z.object({
  catalogId: StableIdSchema,
  name: z.string().nullable(),
  score: ProbabilitySchema,
  rank: z.number().int().positive(),
  matchedReferencePhotoIds: z.array(StableIdSchema),
  explanation: z.string(),
});

export const IdentifyResponseSchema = z.object({
  matches: z.array(IdentifyMatchSchema),
  confidenceBand: IdentifyConfidenceBandSchema,
  model: StableIdSchema,
  indexVersion: StableIdSchema,
  uploadUrl: HttpUrlSchema.optional(),
});

export type IdentifyConfidenceBand = z.infer<typeof IdentifyConfidenceBandSchema>;
export type IdentifyMatchDTO = z.infer<typeof IdentifyMatchSchema>;
export type IdentifyResponseDTO = z.infer<typeof IdentifyResponseSchema>;
