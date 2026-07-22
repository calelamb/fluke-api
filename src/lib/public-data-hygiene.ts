export type PublicDataViolationReason =
  | 'explicit-synthetic-marker'
  | 'known-synthetic-id'
  | 'reserved-observer-domain';

export interface PublicSightingCandidate {
  readonly behaviorNotes: string | null;
  readonly id: string;
  readonly locationName: string | null;
  readonly observerEmail: string;
}

export interface PublicDataViolation {
  readonly reason: PublicDataViolationReason;
  readonly recordId: string;
}

const KNOWN_SYNTHETIC_IDS = new Set([
  'diagnostic-test-pin',
  'fixture-sighting',
  'synthetic-sighting',
]);

const TAGGED_SYNTHETIC_MARKERS = Object.freeze([
  '[diagnostic]',
  '[fixture]',
  '[synthetic]',
  '[test only]',
]);

function normalized(value: string | null | undefined): string {
  return value?.normalize('NFKC').trim().toLocaleLowerCase('en-US') ?? '';
}

function usesReservedObserverDomain(email: string | undefined): boolean {
  const domain = normalized(email).split('@').at(-1);
  return domain === 'invalid' || domain?.endsWith('.invalid') === true;
}

function hasExplicitSyntheticMarker(value: string | null | undefined): boolean {
  const text = normalized(value);
  return text === 'diagnostic test pin'
    || TAGGED_SYNTHETIC_MARKERS.some((marker) => text.includes(marker));
}

export function classifyPublicSighting(
  candidate: PublicSightingCandidate,
): PublicDataViolation | null {
  const recordId = candidate.id;
  if (KNOWN_SYNTHETIC_IDS.has(normalized(recordId))) {
    return Object.freeze({ reason: 'known-synthetic-id', recordId });
  }
  if (usesReservedObserverDomain(candidate.observerEmail)) {
    return Object.freeze({ reason: 'reserved-observer-domain', recordId });
  }
  if (
    hasExplicitSyntheticMarker(candidate.locationName)
    || hasExplicitSyntheticMarker(candidate.behaviorNotes)
  ) {
    return Object.freeze({ reason: 'explicit-synthetic-marker', recordId });
  }
  return null;
}
