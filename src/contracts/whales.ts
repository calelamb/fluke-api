import { z } from 'zod';
import {
  BoundedTextSchema,
  CursorSchema,
  EcotypeSchema,
  HttpUrlSchema,
  IsoDateTimeSchema,
  LatitudeSchema,
  LongitudeSchema,
  MAX_NESTED_ITEMS,
  PageInfoSchema,
  SexSchema,
  StableIdSchema,
  WhaleStatusSchema,
  YearSchema,
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
  year: YearSchema,
  date: BoundedTextSchema.optional(),
  type: NotableEventTypeSchema,
  summary: BoundedTextSchema,
  source: BoundedTextSchema.optional(),
});

export const SourceCitationSchema = z.object({
  label: BoundedTextSchema,
  url: HttpUrlSchema,
});

export const WhaleSchema = z.object({
  id: StableIdSchema,
  catalogId: StableIdSchema,
  name: BoundedTextSchema.nullable(),
  ecotype: EcotypeSchema,
  pod: BoundedTextSchema.nullable(),
  sex: SexSchema,
  birthYear: YearSchema.nullable(),
  deathYear: YearSchema.nullable(),
  status: WhaleStatusSchema,
  biography: BoundedTextSchema.nullable(),
  distinguishingMarks: BoundedTextSchema.nullable(),
  heroImageUrl: HttpUrlSchema.nullable(),
  notableEvents: z.array(NotableEventSchema).max(MAX_NESTED_ITEMS),
  sourceCitations: z.array(SourceCitationSchema).max(MAX_NESTED_ITEMS),
});

const WhaleRelationSchema = z.object({
  catalogId: StableIdSchema,
  name: BoundedTextSchema.nullable(),
});

const RecentSightingSchema = z.object({
  id: StableIdSchema,
  observedAt: IsoDateTimeSchema,
  locationName: BoundedTextSchema.nullable(),
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
});

export const WhaleProfileSchema = WhaleSchema.extend({
  mother: WhaleRelationSchema.nullable(),
  offspring: z.array(WhaleRelationSchema).max(MAX_NESTED_ITEMS),
  recentSightings: z.array(RecentSightingSchema).max(MAX_NESTED_ITEMS),
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
  id: StableIdSchema,
  observedAt: IsoDateTimeSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  locationName: BoundedTextSchema.nullable(),
  behaviorNotes: BoundedTextSchema.nullable(),
}).strict();

export const WhaleTrackSchema = z.object({
  whaleId: StableIdSchema,
  catalogId: StableIdSchema,
  points: z.array(MovementTrackPointSchema).max(MAX_NESTED_ITEMS),
}).strict();

export type NotableEventType = z.infer<typeof NotableEventTypeSchema>;
export type NotableEvent = z.infer<typeof NotableEventSchema>;
export type SourceCitation = z.infer<typeof SourceCitationSchema>;
export type WhaleDTO = z.infer<typeof WhaleSchema>;
export type WhaleProfileDTO = z.infer<typeof WhaleProfileSchema>;
export type WhalePage = z.infer<typeof WhalePageSchema>;
export type WhaleTrack = z.infer<typeof WhaleTrackSchema>;
export type MovementTrackPoint = z.infer<typeof MovementTrackPointSchema>;
