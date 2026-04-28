// Ingest the most recent Acartia / SSEMMI sightings into external_sightings.
//
// Usage:  pnpm ingest:acartia
//
// Idempotent: dedupes on (source, externalId), so re-running doesn't duplicate.
// Acartia's "current" feed only covers the last 7 days, so to accumulate a
// historical record this script needs to run at least weekly. A future cron
// or scheduled job can wire that up.

import { PrismaClient } from '@prisma/client';
import { fetchAcartiaCurrent } from '../src/lib/acartia.js';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching Acartia current sightings...');
  const sightings = await fetchAcartiaCurrent();
  console.log(`Acartia returned ${sightings.length} orca-relevant sightings.`);

  let created = 0;
  let updated = 0;

  for (const s of sightings) {
    const existing = await prisma.externalSighting.findUnique({
      where: {
        source_externalId: { source: s.source, externalId: s.externalId },
      },
    });

    if (existing) {
      await prisma.externalSighting.update({
        where: { id: existing.id },
        data: {
          observedAt: s.observedAt,
          latitude: s.latitude,
          longitude: s.longitude,
          species: s.species,
          ecotypeGuess: s.ecotypeGuess,
          groupSize: s.groupSize,
          attribution: s.attribution,
          sourceUrl: s.sourceUrl,
          notes: s.notes,
          trusted: s.trusted,
          fetchedAt: new Date(),
        },
      });
      updated += 1;
    } else {
      await prisma.externalSighting.create({
        data: {
          source: s.source,
          externalId: s.externalId,
          observedAt: s.observedAt,
          latitude: s.latitude,
          longitude: s.longitude,
          species: s.species,
          ecotypeGuess: s.ecotypeGuess,
          groupSize: s.groupSize,
          attribution: s.attribution,
          sourceUrl: s.sourceUrl,
          notes: s.notes,
          trusted: s.trusted,
        },
      });
      created += 1;
    }
  }

  console.log(`\nIngest complete: ${created} created, ${updated} updated.`);
}

main()
  .catch((error) => {
    console.error('Ingest failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
