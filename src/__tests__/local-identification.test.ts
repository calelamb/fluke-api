import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { LocalIdentificationSuggestion } from '../contracts/index.js';
import {
  InvalidIdentificationReleaseError,
  resolveLocalSuggestion,
  validateIdentifierCatalogInventory,
} from '../services/local-identification.js';

const SCORE_SEMANTICS = 'uncalibrated_similarity_not_probability';
const NOW = new Date('2026-07-18T18:00:00.000Z');

const suggestion: LocalIdentificationSuggestion = {
  catalogId: 'J35',
  indexVersion: 'index-v1',
  manifestVersion: 'manifest-v1',
  matchedReferencePhotoIds: ['reference-j35-left'],
  modelVersion: 'model-v1',
  scoreSemantics: SCORE_SEMANTICS,
  similarityScore: 0.8123456,
};

function transactionWith(
  release: Readonly<Record<string, unknown>>,
  whales: readonly Readonly<{ catalogId: string; id: string }>[],
): Prisma.TransactionClient {
  return {
    identifierRelease: {
      findUnique: vi.fn().mockResolvedValue(release),
    },
    whale: {
      findMany: vi.fn().mockResolvedValue(whales),
    },
  } as unknown as Prisma.TransactionClient;
}

function releaseWith(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    catalogInventory: Object.freeze([
      Object.freeze({ catalogId: 'J35', referencePhotoId: 'reference-j35-left' }),
    ]),
    indexVersion: suggestion.indexVersion,
    modelVersion: suggestion.modelVersion,
    scoreSemantics: suggestion.scoreSemantics,
    status: 'ACTIVE',
    suggestionsAcceptedUntil: null,
    ...overrides,
  });
}

describe('local identification validation', () => {
  it('returns a read-only whale lookup without freezing or mutating Prisma results', async () => {
    const sourceWhale = { catalogId: 'J35', id: 'whale-j35' };
    const originalSource = { ...sourceWhale };
    const transaction = transactionWith(releaseWith(), [sourceWhale]);

    const validated = await validateIdentifierCatalogInventory(
      transaction,
      releaseWith().catalogInventory as Prisma.JsonValue,
    );

    expect(validated.whalesByCatalogId).not.toHaveProperty('set');
    expect(validated.whalesByCatalogId).not.toHaveProperty('delete');
    expect(validated.whalesByCatalogId).not.toHaveProperty('clear');
    expect(Object.isFrozen(validated.whalesByCatalogId)).toBe(true);
    expect(validated.whalesByCatalogId.get('J35')).toEqual(sourceWhale);
    expect(validated.whalesByCatalogId.get('J35')).not.toBe(sourceWhale);
    expect(Object.isFrozen(validated.whalesByCatalogId.get('J35'))).toBe(true);
    expect(sourceWhale).toEqual(originalSource);
    expect(Object.isFrozen(sourceWhale)).toBe(false);
  });

  it('rejects an accepted release exactly at its acceptance deadline', async () => {
    const transaction = transactionWith(releaseWith({
      status: 'ACCEPTED',
      suggestionsAcceptedUntil: NOW,
    }), [{ catalogId: 'J35', id: 'whale-j35' }]);

    await expect(resolveLocalSuggestion(transaction, suggestion, NOW))
      .rejects.toBeInstanceOf(InvalidIdentificationReleaseError);
  });

  it('accepts an active release even when its former acceptance deadline has expired', async () => {
    const transaction = transactionWith(releaseWith({
      status: 'ACTIVE',
      suggestionsAcceptedUntil: new Date('2020-01-01T00:00:00.000Z'),
    }), [{ catalogId: 'J35', id: 'whale-j35' }]);

    await expect(resolveLocalSuggestion(transaction, suggestion, NOW)).resolves.toMatchObject({
      releaseManifestVersion: suggestion.manifestVersion,
      whaleId: 'whale-j35',
    });
  });

  it('accepts 10,000 inventory entries and rejects 10,001', async () => {
    const maximumInventory = Object.freeze(Array.from({ length: 10_000 }, (_, index) =>
      Object.freeze({ catalogId: 'J35', referencePhotoId: `reference-${index}` })));
    const transaction = transactionWith(releaseWith(), [
      { catalogId: 'J35', id: 'whale-j35' },
    ]);

    await expect(validateIdentifierCatalogInventory(
      transaction,
      maximumInventory as unknown as Prisma.JsonValue,
    )).resolves.toMatchObject({ entries: maximumInventory });
    await expect(validateIdentifierCatalogInventory(
      transaction,
      [...maximumInventory, { catalogId: 'J35', referencePhotoId: 'reference-over-limit' }],
    )).rejects.toBeInstanceOf(InvalidIdentificationReleaseError);
  });

  it('rejects extra fields in a release inventory entry', async () => {
    const transaction = transactionWith(releaseWith(), [
      { catalogId: 'J35', id: 'whale-j35' },
    ]);

    await expect(validateIdentifierCatalogInventory(transaction, [{
      catalogId: 'J35',
      clientWhaleName: 'must-not-be-accepted',
      referencePhotoId: 'reference-j35-left',
    }])).rejects.toBeInstanceOf(InvalidIdentificationReleaseError);
  });

  it('rejects a valid release reference that belongs to another whale', async () => {
    const transaction = transactionWith(releaseWith({
      catalogInventory: [
        { catalogId: 'J35', referencePhotoId: 'reference-j35-left' },
        { catalogId: 'J36', referencePhotoId: 'reference-j36-left' },
      ],
    }), [
      { catalogId: 'J35', id: 'whale-j35' },
      { catalogId: 'J36', id: 'whale-j36' },
    ]);

    await expect(resolveLocalSuggestion(transaction, {
      ...suggestion,
      matchedReferencePhotoIds: ['reference-j36-left'],
    }, NOW)).rejects.toBeInstanceOf(InvalidIdentificationReleaseError);
  });
});
