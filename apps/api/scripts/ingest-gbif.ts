// Ingest historical Orcinus orca occurrences from GBIF (Global Biodiversity
// Information Facility) into external_sightings.
//
// GBIF aggregates Orcinus orca records from research datasets, citizen-science
// platforms (iNaturalist), and museum collections. Public, no auth, CC0/CC-BY.
//
// Usage:  pnpm ingest:gbif [--years 5]
// Idempotent: dedupes on (source='gbif', externalId=gbifID).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SALISH_SEA_BBOX = {
  south: 47.0,
  north: 49.5,
  west: -124.7,
  east: -122.0,
};

const GBIF_BASE = 'https://api.gbif.org/v1/occurrence/search';
const PAGE_SIZE = 300;
const MAX_PAGES = 50; // 15k records cap

interface GbifRecord {
  key: number;
  gbifID?: string;
  occurrenceID?: string;
  eventDate?: string;
  decimalLatitude?: number;
  decimalLongitude?: number;
  basisOfRecord?: string;
  year?: number;
  species?: string;
  datasetName?: string;
  publisher?: string;
  recordedBy?: string;
  references?: string;
  occurrenceRemarks?: string;
}

function inSalishSea(r: GbifRecord): boolean {
  if (typeof r.decimalLatitude !== 'number' || typeof r.decimalLongitude !== 'number') return false;
  return (
    r.decimalLatitude >= SALISH_SEA_BBOX.south &&
    r.decimalLatitude <= SALISH_SEA_BBOX.north &&
    r.decimalLongitude >= SALISH_SEA_BBOX.west &&
    r.decimalLongitude <= SALISH_SEA_BBOX.east
  );
}

function inferEcotype(r: GbifRecord): 'BIGGS' | 'RESIDENT' | 'UNKNOWN' {
  const text = `${r.occurrenceRemarks ?? ''} ${r.recordedBy ?? ''} ${r.datasetName ?? ''}`.toLowerCase();
  if (text.includes('bigg') || text.includes('transient')) return 'BIGGS';
  if (text.includes('resident') || text.includes('srkw') || text.includes('northern resident')) return 'RESIDENT';
  return 'UNKNOWN';
}

async function fetchPage(offset: number, fromYear: number): Promise<{ results: GbifRecord[]; endOfRecords: boolean }> {
  const params = new URLSearchParams({
    scientificName: 'Orcinus orca',
    decimalLatitude: `${SALISH_SEA_BBOX.south},${SALISH_SEA_BBOX.north}`,
    decimalLongitude: `${SALISH_SEA_BBOX.west},${SALISH_SEA_BBOX.east}`,
    hasCoordinate: 'true',
    year: `${fromYear},2026`,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });

  const url = `${GBIF_BASE}?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GBIF returned ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { results: GbifRecord[]; endOfRecords: boolean; count: number };
  return data;
}

async function main() {
  const yearsArg = process.argv.indexOf('--years');
  const years = yearsArg >= 0 ? Number(process.argv[yearsArg + 1]) : 5;
  const fromYear = new Date().getUTCFullYear() - years;

  console.log(`ingest-gbif: fetching Orcinus orca records from ${fromYear} onward in Salish Sea bbox...`);

  let totalSeen = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { results, endOfRecords } = await fetchPage(page * PAGE_SIZE, fromYear);
    if (results.length === 0) break;
    totalSeen += results.length;

    for (const r of results) {
      if (!inSalishSea(r)) {
        skipped++;
        continue;
      }
      if (!r.eventDate) {
        skipped++;
        continue;
      }
      const observedAt = new Date(r.eventDate);
      if (Number.isNaN(observedAt.getTime())) {
        skipped++;
        continue;
      }

      const externalId = String(r.key);
      const data = {
        observedAt,
        latitude: r.decimalLatitude!,
        longitude: r.decimalLongitude!,
        species: r.species ?? 'Orcinus orca',
        ecotypeGuess: inferEcotype(r),
        groupSize: null,
        attribution: r.publisher ?? r.datasetName ?? 'GBIF',
        sourceUrl: r.references ?? `https://www.gbif.org/occurrence/${r.key}`,
        notes: r.occurrenceRemarks ?? null,
        trusted: r.basisOfRecord === 'HUMAN_OBSERVATION' || r.basisOfRecord === 'OBSERVATION',
      };

      const existing = await prisma.externalSighting.findUnique({
        where: { source_externalId: { source: 'gbif', externalId } },
      });

      if (existing) {
        await prisma.externalSighting.update({
          where: { id: existing.id },
          data: { ...data, fetchedAt: new Date() },
        });
        updated++;
      } else {
        await prisma.externalSighting.create({
          data: { source: 'gbif', externalId, ...data },
        });
        created++;
      }
    }

    console.log(`  page ${page + 1}: ${results.length} records (${created} created, ${updated} updated, ${skipped} skipped so far)`);
    if (endOfRecords) break;
  }

  console.log(`\ningest-gbif: done. seen ${totalSeen}, created ${created}, updated ${updated}, skipped ${skipped}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
