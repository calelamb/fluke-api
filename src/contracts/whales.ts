import { z } from 'zod';
import { EcotypeSchema, SexSchema, WhaleStatusSchema } from './common.js';

export const NotableEventTypeSchema = z.enum([
  'birth',
  'death',
  'loss',
  'capture',
  'release',
  'pod-switch',
  'first-documented',
  'milestone',
]);

export const NotableEventSchema = z.object({
  year: z.number(),
  date: z.string().optional(),
  type: NotableEventTypeSchema,
  summary: z.string(),
  source: z.string().optional(),
});

export const SourceCitationSchema = z.object({
  label: z.string(),
  url: z.string(),
});

export const WhaleSchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  name: z.string().nullable(),
  ecotype: EcotypeSchema,
  pod: z.string().nullable(),
  sex: SexSchema,
  birthYear: z.number().int().nullable(),
  deathYear: z.number().int().nullable(),
  status: WhaleStatusSchema,
  biography: z.string().nullable(),
  distinguishingMarks: z.string().nullable(),
  heroImageUrl: z.string().nullable(),
  notableEvents: z.array(NotableEventSchema),
  sourceCitations: z.array(SourceCitationSchema),
});

const WhaleRelationSchema = z.object({
  catalogId: z.string(),
  name: z.string().nullable(),
});

const RecentSightingSchema = z.object({
  id: z.string(),
  observedAt: z.string(),
  locationName: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
});

export const WhaleProfileSchema = WhaleSchema.extend({
  mother: WhaleRelationSchema.nullable(),
  offspring: z.array(WhaleRelationSchema),
  recentSightings: z.array(RecentSightingSchema),
});

export type NotableEventType = z.infer<typeof NotableEventTypeSchema>;
export type NotableEvent = z.infer<typeof NotableEventSchema>;
export type SourceCitation = z.infer<typeof SourceCitationSchema>;
export type WhaleDTO = z.infer<typeof WhaleSchema>;
export type WhaleProfileDTO = z.infer<typeof WhaleProfileSchema>;
