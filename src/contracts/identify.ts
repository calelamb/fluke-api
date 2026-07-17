import { z } from 'zod';

export const IdentifyConfidenceBandSchema = z.enum([
  'high',
  'medium',
  'low',
  'unavailable',
]);

export const IdentifyMatchSchema = z.object({
  catalogId: z.string(),
  name: z.string().nullable(),
  score: z.number(),
  rank: z.number().int(),
  matchedReferencePhotoIds: z.array(z.string()),
  explanation: z.string(),
});

export const IdentifyResponseSchema = z.object({
  matches: z.array(IdentifyMatchSchema),
  confidenceBand: IdentifyConfidenceBandSchema,
  model: z.string().min(1),
  indexVersion: z.string().min(1),
  uploadUrl: z.string().url().optional(),
});

export type IdentifyConfidenceBand = z.infer<typeof IdentifyConfidenceBandSchema>;
export type IdentifyMatchDTO = z.infer<typeof IdentifyMatchSchema>;
export type IdentifyResponseDTO = z.infer<typeof IdentifyResponseSchema>;
