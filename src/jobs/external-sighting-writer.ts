import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  ProviderExternalIdSchema,
  ProviderSourceSchema,
} from '../lib/public-feed-id.js';

const MAX_WRITE_BATCH_SIZE = 200;
const MAX_RECONCILIATION_IDENTITIES = 15_000;

const ExternalSightingInputSchema = z.object({
  attribution: z.string().min(1).max(20_000),
  ecotypeGuess: z.enum(['RESIDENT', 'BIGGS', 'OFFSHORE', 'UNKNOWN']).nullable(),
  externalId: ProviderExternalIdSchema,
  groupSize: z.number().int().min(1).max(200).nullable(),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  notes: z.string().max(20_000).nullable(),
  observedAt: z.date(),
  source: ProviderSourceSchema,
  sourceUrl: z.string().url().max(2_048).regex(/^https?:\/\//u).nullable(),
  species: z.string().min(1).max(20_000),
  trusted: z.boolean(),
}).strict();

const ExternalRemovalSchema = z.object({
  externalIds: z.array(ProviderExternalIdSchema).max(MAX_WRITE_BATCH_SIZE),
  fetchedAt: z.date(),
  source: ProviderSourceSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.externalIds).size !== value.externalIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'external IDs must be unique',
      path: ['externalIds'],
    });
  }
});

const ExternalReconciliationSchema = z.object({
  externalIds: z.array(ProviderExternalIdSchema).max(MAX_RECONCILIATION_IDENTITIES),
  fetchedAt: z.date(),
  observedFrom: z.date(),
  observedTo: z.date(),
  source: ProviderSourceSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.externalIds).size !== value.externalIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'external IDs must be unique',
      path: ['externalIds'],
    });
  }
  if (value.observedFrom.getTime() > value.observedTo.getTime()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'observedFrom must not be after observedTo',
      path: ['observedFrom'],
    });
  }
});

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

export interface ExternalSightingRemovalClient {
  readonly externalSighting: {
    updateMany(args: Prisma.ExternalSightingUpdateManyArgs): Promise<{ count: number }>;
  };
}

export async function upsertExternalSightings(
  client: ExternalSightingWriterClient,
  sightings: readonly ExternalSightingInput[],
  fetchedAt: Date,
): Promise<number> {
  if (sightings.length > MAX_WRITE_BATCH_SIZE) {
    throw new Error(`External sighting batch must not exceed ${MAX_WRITE_BATCH_SIZE} items`);
  }
  if (!Number.isFinite(fetchedAt.getTime())) {
    throw new Error('fetchedAt must be a valid date');
  }
  const validatedSightings = sightings.map((sighting) => (
    Object.freeze(ExternalSightingInputSchema.parse(sighting))
  ));
  for (const sighting of validatedSightings) {
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
      publicFeedRemovedAt: null,
    };
    await client.externalSighting.upsert({
      create: {
        ...mutableFields,
        externalId: sighting.externalId,
        firstFetchedAt: fetchedAt,
        source: sighting.source,
        updatedAt: fetchedAt,
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
  return validatedSightings.length;
}

export async function removeExternalSightings(
  client: ExternalSightingRemovalClient,
  source: string,
  externalIds: readonly string[],
  fetchedAt: Date,
): Promise<number> {
  const input = ExternalRemovalSchema.parse({ externalIds, fetchedAt, source });
  if (input.externalIds.length === 0) return 0;

  const result = await client.externalSighting.updateMany({
    data: {
      fetchedAt: input.fetchedAt,
      publicFeedRemovedAt: input.fetchedAt,
    },
    where: {
      externalId: { in: [...input.externalIds] },
      publicFeedRemovedAt: null,
      source: input.source,
    },
  });
  return result.count;
}

export async function reconcileExternalSightings(
  client: ExternalSightingRemovalClient,
  source: string,
  externalIds: readonly string[],
  observedFrom: Date,
  observedTo: Date,
  fetchedAt: Date,
): Promise<number> {
  const input = ExternalReconciliationSchema.parse({
    externalIds,
    fetchedAt,
    observedFrom,
    observedTo,
    source,
  });
  const result = await client.externalSighting.updateMany({
    data: {
      fetchedAt: input.fetchedAt,
      publicFeedRemovedAt: input.fetchedAt,
    },
    where: {
      externalId: { notIn: [...input.externalIds] },
      observedAt: { gte: input.observedFrom, lte: input.observedTo },
      publicFeedRemovedAt: null,
      source: input.source,
    },
  });
  return result.count;
}
