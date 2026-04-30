export type Ecotype = 'RESIDENT' | 'BIGGS' | 'OFFSHORE' | 'UNKNOWN';
export type Sex = 'MALE' | 'FEMALE' | 'UNKNOWN';
export type WhaleStatus = 'ALIVE' | 'DECEASED' | 'UNKNOWN';
export type SightingStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type IdConfidence = 'CONFIRMED' | 'LIKELY' | 'ML_SUGGESTED';
export type PhotoQuality =
  | 'USABLE'
  | 'OCCLUDED'
  | 'MOTION_BLUR'
  | 'WRONG_ANGLE'
  | 'TOO_DISTANT'
  | 'NOT_ORCA';
export type ReferencePhotoSide = 'LEFT' | 'RIGHT' | 'UNKNOWN';
export type EmbeddingStatus = 'PENDING' | 'EMBEDDED' | 'FAILED';

export const LABEL_PHOTO_AUDIT_ACTION = 'LABEL_PHOTO' as const;

export type NotableEventType =
  | 'birth'
  | 'death'
  | 'loss'
  | 'capture'
  | 'release'
  | 'pod-switch'
  | 'first-documented'
  | 'milestone';

export interface NotableEvent {
  year: number;
  date?: string;
  type: NotableEventType;
  summary: string;
  source?: string;
}

export interface SourceCitation {
  label: string;
  url: string;
}

export interface WhaleDTO {
  id: string;
  catalogId: string;
  name: string | null;
  ecotype: Ecotype;
  pod: string | null;
  sex: Sex;
  birthYear: number | null;
  deathYear: number | null;
  status: WhaleStatus;
  biography: string | null;
  distinguishingMarks: string | null;
  heroImageUrl: string | null;
  notableEvents: NotableEvent[];
  sourceCitations: SourceCitation[];
}

export interface WhaleProfileDTO extends WhaleDTO {
  mother: { catalogId: string; name: string | null } | null;
  offspring: Array<{ catalogId: string; name: string | null }>;
  recentSightings: Array<{
    id: string;
    observedAt: string;
    locationName: string | null;
    latitude: number;
    longitude: number;
  }>;
}

export interface SightingDTO {
  id: string;
  observedAt: string;
  latitude: number;
  longitude: number;
  locationName: string | null;
  ecotypeGuess: Ecotype | null;
  groupSize: number | null;
  behaviorNotes: string | null;
  status: SightingStatus;
  /**
   * Convenience: large-image URLs in display order. Mirrors `photos[].url`
   * for callers that just want to preload images.
   */
  photoUrls: string[];
  photos: SightingPhotoDTO[];
  identifiedWhales: Array<{
    catalogId: string;
    name: string | null;
    confidence: IdConfidence;
  }>;
}

export interface SightingPhotoDTO {
  id: string;
  url: string;
  thumbnailUrl: string;
  orderIndex: number;
}

export interface PendingSightingDTO {
  id: string;
  observedAt: string;
  latitude: number;
  longitude: number;
  locationName: string | null;
  ecotypeGuess: Ecotype | null;
  groupSize: number | null;
  behaviorNotes: string | null;
  observerName: string | null;
  observerEmail: string;
  status: SightingStatus;
  createdAt: string;
  identifiedWhales: Array<{
    catalogId: string;
    name: string | null;
    confidence: IdConfidence;
  }>;
  photos: SightingPhotoDTO[];
}

export interface SubmitSightingPayload {
  observedAt: string;
  latitude: number;
  longitude: number;
  locationName?: string | null;
  ecotypeGuess?: Ecotype | null;
  groupSize?: number | null;
  behaviorNotes?: string | null;
  observerName?: string | null;
  observerEmail: string;
}

/**
 * Response from POST /api/v1/sightings. The `photoUploadToken` is a JWT
 * scoped to this sighting and the photo-upload action; the offline submission
 * queue replays photo uploads with this token so they can land past the
 * 30-minute public upload window.
 */
export interface SubmitSightingResponse {
  ok: true;
  id: string;
  photoUploadToken: string;
}

/**
 * Bounding-box payload stored on a `PhotoAnnotation`. Pixel-space coordinates
 * relative to the original (not thumbnail) photo. Both boxes optional — a
 * `NOT_ORCA` photo carries `{}` and `boxes` is empty.
 */
export interface PhotoAnnotationBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhotoAnnotationPayload {
  dorsal_fin?: PhotoAnnotationBox;
  saddle_patch?: PhotoAnnotationBox;
}

export interface PhotoAnnotationDTO {
  id: string;
  photoId: string;
  version: number;
  quality: PhotoQuality;
  whaleCatalogId: string | null;
  whaleName: string | null;
  confidence: IdConfidence | null;
  payload: PhotoAnnotationPayload;
  notes: string | null;
  done: boolean;
  labeledById: string;
  labeledAt: string;
}

/**
 * Photo waiting on (or already partially through) labeling. Surfaced by the
 * admin label queue. `latestAnnotation` is the highest-version annotation
 * row for the photo, or null if none exist yet.
 */
export interface LabelablePhotoDTO {
  id: string;
  url: string;
  thumbnailUrl: string;
  orderIndex: number;
  done: boolean;
  createdAt: string;
  sighting: {
    id: string;
    observedAt: string;
    locationName: string | null;
    observerEmail: string;
  };
  latestAnnotation: PhotoAnnotationDTO | null;
}

export interface WhaleReferencePhotoDTO {
  id: string;
  whaleId: string;
  catalogId: string;
  whaleName: string | null;
  url: string;
  side: ReferencePhotoSide;
  quality: PhotoQuality;
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
  embeddingStatus: EmbeddingStatus;
  notes: string | null;
  createdAt: string;
}

export type IdentifyConfidenceBand = 'high' | 'medium' | 'low' | 'unavailable';

export interface IdentifyMatchDTO {
  catalogId: string;
  name: string | null;
  score: number;
  rank: number;
  matchedReferencePhotoIds: string[];
  explanation: string;
}

export interface IdentifyResponseDTO {
  matches: IdentifyMatchDTO[];
  confidenceBand: IdentifyConfidenceBand;
  model: string;
  indexVersion: string;
  uploadUrl?: string;
}

export interface ExternalSightingDTO {
  id: string;
  source: string;
  externalId: string;
  observedAt: string;
  latitude: number;
  longitude: number;
  species: string;
  ecotypeGuess: Ecotype | null;
  groupSize: number | null;
  attribution: string;
  sourceUrl: string | null;
  notes: string | null;
  trusted: boolean;
}
