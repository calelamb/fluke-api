import { z } from 'zod';
import {
  BoundedTextSchema,
  IsoDateTimeSchema,
  LatitudeSchema,
  LongitudeSchema,
  MAX_NESTED_ITEMS,
  ProbabilitySchema,
} from './common.js';

export const PredictionCellSchema = z.object({
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  probability: ProbabilitySchema,
});

export const PredictionSchema = z.object({
  cells: z.array(PredictionCellSchema).max(MAX_NESTED_ITEMS),
  confidence: ProbabilitySchema,
  modelVersion: BoundedTextSchema,
  computedAt: IsoDateTimeSchema,
});

export type PredictionCell = z.infer<typeof PredictionCellSchema>;
export type Prediction = z.infer<typeof PredictionSchema>;
