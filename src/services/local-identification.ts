import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  StableIdSchema,
  type LocalIdentificationSuggestion,
} from '../contracts/index.js';

export const INVALID_IDENTIFICATION_RELEASE = 'INVALID_IDENTIFICATION_RELEASE';
const MAX_CATALOG_INVENTORY_ENTRIES = 10_000;

const IdentifierCatalogInventoryEntrySchema = z.object({
  referencePhotoId: StableIdSchema,
  catalogId: StableIdSchema,
}).strict();

export const IdentifierCatalogInventorySchema = z.array(
  IdentifierCatalogInventoryEntrySchema,
).max(MAX_CATALOG_INVENTORY_ENTRIES).superRefine((entries, context) => {
  const referencePhotoIds = entries.map((entry) => entry.referencePhotoId);
  if (new Set(referencePhotoIds).size !== referencePhotoIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'reference photo IDs must be unique',
      path: [],
    });
  }
});

type InventoryEntry = z.infer<typeof IdentifierCatalogInventoryEntrySchema>;

export interface CanonicalWhale {
  readonly catalogId: string;
  readonly id: string;
}

export interface CanonicalWhaleLookup {
  readonly get: (catalogId: string) => CanonicalWhale | undefined;
}

export interface ValidatedIdentifierCatalogInventory {
  readonly entries: readonly Readonly<InventoryEntry>[];
  readonly whalesByCatalogId: CanonicalWhaleLookup;
}

export interface ResolvedLocalSuggestion {
  readonly matchedReferencePhotoIds: readonly string[];
  readonly releaseManifestVersion: string;
  readonly scoreSemantics: LocalIdentificationSuggestion['scoreSemantics'];
  readonly similarityScore: number;
  readonly status: 'PENDING';
  readonly whaleId: string;
}

interface ReleaseRecord {
  readonly catalogInventory: Prisma.JsonValue;
  readonly indexVersion: string;
  readonly modelVersion: string;
  readonly scoreSemantics: string;
  readonly status: 'ACCEPTED' | 'ACTIVE' | 'REVOKED';
  readonly suggestionsAcceptedUntil: Date | null;
}

export class InvalidIdentificationReleaseError extends Error {
  readonly code = INVALID_IDENTIFICATION_RELEASE;
  readonly statusCode = 422;

  constructor() {
    super('Local identification evidence is not accepted.');
    this.name = 'InvalidIdentificationReleaseError';
  }
}

function invalidRelease(): never {
  throw new InvalidIdentificationReleaseError();
}

function immutableEntries(entries: readonly InventoryEntry[]): readonly Readonly<InventoryEntry>[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

function releaseAcceptsSuggestions(release: ReleaseRecord, now: Date): boolean {
  if (release.status === 'ACTIVE') return true;
  return release.status === 'ACCEPTED'
    && release.suggestionsAcceptedUntil !== null
    && release.suggestionsAcceptedUntil.getTime() > now.getTime();
}

function versionsMatch(
  release: ReleaseRecord,
  input: LocalIdentificationSuggestion,
): boolean {
  return release.indexVersion === input.indexVersion
    && release.modelVersion === input.modelVersion
    && release.scoreSemantics === input.scoreSemantics;
}

function canonicalWhaleLookup(
  whales: readonly CanonicalWhale[],
  expectedCatalogIds: ReadonlySet<string>,
): CanonicalWhaleLookup {
  const immutableWhales = whales.map((whale) => Object.freeze({ ...whale }));
  const byCatalogId = new Map(immutableWhales.map((whale) => [whale.catalogId, whale]));
  if (byCatalogId.size !== expectedCatalogIds.size) invalidRelease();
  for (const catalogId of expectedCatalogIds) {
    if (!byCatalogId.has(catalogId)) invalidRelease();
  }
  return Object.freeze({
    get: (catalogId: string): CanonicalWhale | undefined => byCatalogId.get(catalogId),
  });
}

export async function validateIdentifierCatalogInventory(
  transaction: Prisma.TransactionClient,
  value: Prisma.JsonValue,
): Promise<ValidatedIdentifierCatalogInventory> {
  const parsed = IdentifierCatalogInventorySchema.safeParse(value);
  if (!parsed.success) invalidRelease();
  const entries = immutableEntries(parsed.data);
  const catalogIds = new Set(entries.map((entry) => entry.catalogId));
  const whales = await transaction.whale.findMany({
    where: { catalogId: { in: [...catalogIds] } },
    select: { catalogId: true, id: true },
  });
  return Object.freeze({
    entries,
    whalesByCatalogId: canonicalWhaleLookup(whales, catalogIds),
  });
}

function validateSuggestionMembership(
  input: LocalIdentificationSuggestion,
  inventory: ValidatedIdentifierCatalogInventory,
): CanonicalWhale {
  const whale = inventory.whalesByCatalogId.get(input.catalogId);
  if (whale === undefined) invalidRelease();
  const entriesByReferenceId = new Map(
    inventory.entries.map((entry) => [entry.referencePhotoId, entry]),
  );
  for (const referencePhotoId of input.matchedReferencePhotoIds) {
    if (entriesByReferenceId.get(referencePhotoId)?.catalogId !== input.catalogId) {
      invalidRelease();
    }
  }
  return whale;
}

export async function resolveLocalSuggestion(
  transaction: Prisma.TransactionClient,
  input: LocalIdentificationSuggestion,
  now: Date,
): Promise<ResolvedLocalSuggestion> {
  const release = await transaction.identifierRelease.findUnique({
    where: { manifestVersion: input.manifestVersion },
    select: {
      catalogInventory: true,
      indexVersion: true,
      modelVersion: true,
      scoreSemantics: true,
      status: true,
      suggestionsAcceptedUntil: true,
    },
  });
  if (release === null || !releaseAcceptsSuggestions(release, now)) invalidRelease();
  if (!versionsMatch(release, input)) invalidRelease();
  const inventory = await validateIdentifierCatalogInventory(
    transaction,
    release.catalogInventory,
  );
  const whale = validateSuggestionMembership(input, inventory);

  return Object.freeze({
    matchedReferencePhotoIds: Object.freeze([...input.matchedReferencePhotoIds]),
    releaseManifestVersion: input.manifestVersion,
    scoreSemantics: input.scoreSemantics,
    similarityScore: input.similarityScore,
    status: 'PENDING',
    whaleId: whale.id,
  });
}
