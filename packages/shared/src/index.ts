export type Ecotype = 'RESIDENT' | 'BIGGS' | 'OFFSHORE' | 'UNKNOWN';
export type Sex = 'MALE' | 'FEMALE' | 'UNKNOWN';
export type WhaleStatus = 'ALIVE' | 'DECEASED' | 'UNKNOWN';
export type SightingStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type IdConfidence = 'CONFIRMED' | 'LIKELY' | 'ML_SUGGESTED';

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
