import { z } from 'zod';

export const PredictionCellSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  probability: z.number(),
});

export const PredictionSchema = z.object({
  cells: z.array(PredictionCellSchema),
  confidence: z.number(),
  modelVersion: z.string(),
  computedAt: z.string(),
});

export type PredictionCell = z.infer<typeof PredictionCellSchema>;
export type Prediction = z.infer<typeof PredictionSchema>;
