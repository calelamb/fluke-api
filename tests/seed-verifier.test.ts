import { describe, expect, it } from 'vitest';
import {
  CANONICAL_WHALES,
  SeedVerificationError,
  verifyCanonicalSeedRows,
} from '../src/ops/seed-verifier.js';

const namesByCatalogId: Readonly<Record<string, string | null>> = {
  J2: 'Granny',
  J35: 'Tahlequah',
  J47: 'Notch',
  J57: 'Phoenix',
  J17: 'Princess Angeline',
  J16: 'Slick',
  J26: 'Mike',
  L87: 'Onyx',
  L25: 'Ocean Sun',
  TOKI: 'Tokitae / Sk’aliCh’elh-tenaut',
  T065A2: 'Ooxjaa',
  T049A1: 'Noah',
  T037A1B: null,
};

function validRows(): readonly unknown[] {
  return CANONICAL_WHALES.map((expected) => ({
    catalogId: expected.catalogId,
    name: namesByCatalogId[expected.catalogId],
    ecotype: expected.ecotype,
    pod: expected.pod,
    biography: `Curated biography for ${expected.catalogId}`,
    mother: expected.motherCatalogId ? { catalogId: expected.motherCatalogId } : null,
    sourceCitations: expected.citationUrls.map((url) => ({ label: 'Authoritative source', url })),
  }));
}

describe('canonical production seed verifier', () => {
  it('defines the expected 13 whale identities', () => {
    expect(CANONICAL_WHALES.map(({ catalogId }) => catalogId)).toEqual([
      'J2',
      'J35',
      'J47',
      'J57',
      'J17',
      'J16',
      'J26',
      'L87',
      'L25',
      'TOKI',
      'T065A2',
      'T049A1',
      'T037A1B',
    ]);
  });

  it('accepts all canonical identities, lineages, biographies, and citations', () => {
    expect(verifyCanonicalSeedRows(validRows())).toEqual({
      whalesChecked: 13,
      lineagesChecked: 4,
      citationsChecked: 19,
    });
  });

  it('rejects a missing canonical whale', () => {
    expect(() => verifyCanonicalSeedRows(validRows().slice(1))).toThrowError(
      new SeedVerificationError('Canonical seed verification failed: missing whale J2.'),
    );
  });

  it('rejects incorrect maternal lineage', () => {
    const rows = validRows().map((row) =>
      typeof row === 'object' && row !== null && 'catalogId' in row && row.catalogId === 'J35'
        ? { ...row, mother: { catalogId: 'J2' } }
        : row,
    );

    expect(() => verifyCanonicalSeedRows(rows)).toThrowError(
      new SeedVerificationError(
        'Canonical seed verification failed: J35 expected mother J17 but found J2.',
      ),
    );
  });

  it('rejects missing authoritative citations', () => {
    const rows = validRows().map((row) =>
      typeof row === 'object' && row !== null && 'catalogId' in row && row.catalogId === 'J35'
        ? { ...row, sourceCitations: [] }
        : row,
    );

    expect(() => verifyCanonicalSeedRows(rows)).toThrowError(
      new SeedVerificationError(
        'Canonical seed verification failed: J35 citations do not match the canonical sources.',
      ),
    );
  });

  it('rejects an empty biography', () => {
    const rows = validRows().map((row) =>
      typeof row === 'object' && row !== null && 'catalogId' in row && row.catalogId === 'J2'
        ? { ...row, biography: ' ' }
        : row,
    );

    expect(() => verifyCanonicalSeedRows(rows)).toThrowError(
      new SeedVerificationError('Canonical seed verification failed: J2 has invalid seed data.'),
    );
  });
});
