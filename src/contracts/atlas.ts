import { z } from 'zod';
import { IsoDateTimeSchema, LatitudeSchema, LongitudeSchema, ProbabilitySchema } from './common.js';

export const PredictionCellSchema = z.object({
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  probability: ProbabilitySchema,
});

export const PredictionSchema = z.object({
  cells: z.array(PredictionCellSchema),
  confidence: ProbabilitySchema,
  modelVersion: z.string(),
  computedAt: IsoDateTimeSchema,
});

export type PredictionCell = z.infer<typeof PredictionCellSchema>;
export type Prediction = z.infer<typeof PredictionSchema>;
