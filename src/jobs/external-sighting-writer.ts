import type { Prisma } from '@prisma/client';

export interface ExternalSightingInput {
  readonly attribution: string;
  readonly ecotypeGuess: 'RESIDENT' | 'BIGGS' | 'OFFSHORE' | 'UNKNOWN' | null;
  readonly externalId: string;
  readonly groupSize: number | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly notes: string | null;
  readonly observedAt: Date;
  readonly source: string;
  readonly sourceUrl: string | null;
  readonly species: string;
  readonly trusted: boolean;
}

export interface ExternalSightingWriterClient {
  readonly externalSighting: {
    upsert(args: Prisma.ExternalSightingUpsertArgs): Promise<unknown>;
  };
}

export async function upsertExternalSightings(
  client: ExternalSightingWriterClient,
  sightings: readonly ExternalSightingInput[],
  fetchedAt: Date,
): Promise<number> {
  for (const sighting of sightings) {
    const mutableFields = {
      attribution: sighting.attribution,
      ecotypeGuess: sighting.ecotypeGuess,
      fetchedAt,
      groupSize: sighting.groupSize,
      latitude: sighting.latitude,
      longitude: sighting.longitude,
      notes: sighting.notes,
      observedAt: sighting.observedAt,
      sourceUrl: sighting.sourceUrl,
      species: sighting.species,
      trusted: sighting.trusted,
    };
    await client.externalSighting.upsert({
      create: {
        ...mutableFields,
        externalId: sighting.externalId,
        source: sighting.source,
      },
      update: mutableFields,
      where: {
        source_externalId: {
          externalId: sighting.externalId,
          source: sighting.source,
        },
      },
    });
  }
  return sightings.length;
}
