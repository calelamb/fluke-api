import { z } from 'zod';

interface CanonicalWhale {
  readonly catalogId: string;
  readonly name: string | null;
  readonly ecotype: 'RESIDENT' | 'BIGGS';
  readonly pod: string;
  readonly motherCatalogId: string | null;
  readonly citationUrls: readonly string[];
}

const CWR = 'https://www.whaleresearch.com/';
const ORCA_NETWORK = 'https://www.orcanetwork.org/';
const BAY_CETOLOGY = 'https://www.bcwhales.org/';
const NOAA_SRKW =
  'https://www.fisheries.noaa.gov/west-coast/endangered-species-conservation/southern-resident-killer-whales-recovery-program';

export const CANONICAL_WHALES = [
  {
    catalogId: 'J2', name: 'Granny', ecotype: 'RESIDENT', pod: 'J', motherCatalogId: null,
    citationUrls: [CWR, ORCA_NETWORK],
  },
  {
    catalogId: 'J35', name: 'Tahlequah', ecotype: 'RESIDENT', pod: 'J', motherCatalogId: 'J17',
    citationUrls: [CWR, ORCA_NETWORK, NOAA_SRKW],
  },
  {
    catalogId: 'J47', name: 'Notch', ecotype: 'RESIDENT', pod: 'J', motherCatalogId: 'J35',
    citationUrls: [CWR],
  },
  {
    catalogId: 'J57', name: 'Phoenix', ecotype: 'RESIDENT', pod: 'J', motherCatalogId: 'J35',
    citationUrls: [CWR],
  },
  {
    catalogId: 'J17', name: 'Princess Angeline', ecotype: 'RESIDENT', pod: 'J', motherCatalogId: null,
    citationUrls: [CWR, NOAA_SRKW],
  },
  {
    catalogId: 'J16', name: 'Slick', ecotype: 'RESIDENT', pod: 'J', motherCatalogId: null,
    citationUrls: [CWR],
  },
  {
    catalogId: 'J26', name: 'Mike', ecotype: 'RESIDENT', pod: 'J', motherCatalogId: null,
    citationUrls: [CWR],
  },
  {
    catalogId: 'L87', name: 'Onyx', ecotype: 'RESIDENT', pod: 'L', motherCatalogId: null,
    citationUrls: [CWR],
  },
  {
    catalogId: 'L25', name: 'Ocean Sun', ecotype: 'RESIDENT', pod: 'L', motherCatalogId: null,
    citationUrls: [CWR, ORCA_NETWORK],
  },
  {
    catalogId: 'TOKI', name: 'Tokitae / Sk’aliCh’elh-tenaut', ecotype: 'RESIDENT', pod: 'L',
    motherCatalogId: 'L25', citationUrls: [ORCA_NETWORK, CWR],
  },
  {
    catalogId: 'T065A2', name: 'Ooxjaa', ecotype: 'BIGGS', pod: 'T065A matriline',
    motherCatalogId: null, citationUrls: [BAY_CETOLOGY],
  },
  {
    catalogId: 'T049A1', name: 'Noah', ecotype: 'BIGGS', pod: 'T049A matriline',
    motherCatalogId: null, citationUrls: [BAY_CETOLOGY],
  },
  {
    catalogId: 'T037A1B', name: null, ecotype: 'BIGGS', pod: 'T037A matriline',
    motherCatalogId: null, citationUrls: [BAY_CETOLOGY],
  },
] as const satisfies readonly CanonicalWhale[];

const citationSchema = z.object({
  label: z.string().trim().min(1),
  url: z.string().url(),
});

const whaleRowSchema = z.object({
  catalogId: z.string().trim().min(1),
  name: z.string().trim().min(1).nullable(),
  ecotype: z.enum(['RESIDENT', 'BIGGS', 'OFFSHORE', 'UNKNOWN']),
  pod: z.string().trim().min(1).nullable(),
  biography: z.string().trim().min(1),
  mother: z.object({ catalogId: z.string().trim().min(1) }).nullable(),
  sourceCitations: z.array(citationSchema),
});

export interface SeedVerificationReport {
  readonly whalesChecked: number;
  readonly lineagesChecked: number;
  readonly citationsChecked: number;
}

export class SeedVerificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SeedVerificationError';
  }
}

function fail(reason: string): never {
  throw new SeedVerificationError(`Canonical seed verification failed: ${reason}`);
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function verifyWhale(raw: unknown, expected: CanonicalWhale): number {
  const parsed = whaleRowSchema.safeParse(raw);
  if (!parsed.success) fail(`${expected.catalogId} has invalid seed data.`);

  const row = parsed.data;
  if (row.name !== expected.name || row.ecotype !== expected.ecotype || row.pod !== expected.pod) {
    fail(`${expected.catalogId} identity does not match the canonical seed.`);
  }

  const actualMother = row.mother?.catalogId ?? null;
  if (actualMother !== expected.motherCatalogId) {
    fail(
      `${expected.catalogId} expected mother ${expected.motherCatalogId ?? 'none'} but found ${actualMother ?? 'none'}.`,
    );
  }

  const actualUrls = sorted(row.sourceCitations.map(({ url }) => url));
  const expectedUrls = sorted(expected.citationUrls);
  if (JSON.stringify(actualUrls) !== JSON.stringify(expectedUrls)) {
    fail(`${expected.catalogId} citations do not match the canonical sources.`);
  }

  return actualUrls.length;
}

export function verifyCanonicalSeedRows(rows: readonly unknown[]): SeedVerificationReport {
  const rowsByCatalogId = new Map(
    rows.flatMap((row) => {
      if (typeof row !== 'object' || row === null || !('catalogId' in row)) return [];
      return [[String(row.catalogId), row] as const];
    }),
  );

  let citationsChecked = 0;
  for (const expected of CANONICAL_WHALES) {
    const row = rowsByCatalogId.get(expected.catalogId);
    if (!row) fail(`missing whale ${expected.catalogId}.`);
    citationsChecked += verifyWhale(row, expected);
  }

  return {
    whalesChecked: CANONICAL_WHALES.length,
    lineagesChecked: CANONICAL_WHALES.filter(({ motherCatalogId }) => motherCatalogId !== null).length,
    citationsChecked,
  };
}
