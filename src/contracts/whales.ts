import { z } from 'zod';
import {
  CursorSchema,
  EcotypeSchema,
  HttpUrlSchema,
  IsoDateTimeSchema,
  LatitudeSchema,
  LongitudeSchema,
  PageInfoSchema,
  SexSchema,
  WhaleStatusSchema,
} from './common.js';

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
  url: HttpUrlSchema,
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
  heroImageUrl: HttpUrlSchema.nullable(),
  notableEvents: z.array(NotableEventSchema),
  sourceCitations: z.array(SourceCitationSchema),
});

const WhaleRelationSchema = z.object({
  catalogId: z.string(),
  name: z.string().nullable(),
});

const RecentSightingSchema = z.object({
  id: z.string(),
  observedAt: IsoDateTimeSchema,
  locationName: z.string().nullable(),
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
});

export const WhaleProfileSchema = WhaleSchema.extend({
  mother: WhaleRelationSchema.nullable(),
  offspring: z.array(WhaleRelationSchema),
  recentSightings: z.array(RecentSightingSchema),
});

export const WhalesQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
}).strict();

export const WhalePageSchema = z.object({
  items: z.array(WhaleSchema).max(50),
  page: PageInfoSchema,
}).strict();

export const MovementTrackPointSchema = z.object({
  id: z.string().min(1),
  observedAt: IsoDateTimeSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  locationName: z.string().nullable(),
  behaviorNotes: z.string().nullable(),
}).strict();

export const WhaleTrackSchema = z.object({
  whaleId: z.string().min(1),
  catalogId: z.string().min(1),
  points: z.array(MovementTrackPointSchema).max(1000),
}).strict();

export type NotableEventType = z.infer<typeof NotableEventTypeSchema>;
export type NotableEvent = z.infer<typeof NotableEventSchema>;
export type SourceCitation = z.infer<typeof SourceCitationSchema>;
export type WhaleDTO = z.infer<typeof WhaleSchema>;
export type WhaleProfileDTO = z.infer<typeof WhaleProfileSchema>;
export type WhalePage = z.infer<typeof WhalePageSchema>;
export type WhaleTrack = z.infer<typeof WhaleTrackSchema>;
export type MovementTrackPoint = z.infer<typeof MovementTrackPointSchema>;
