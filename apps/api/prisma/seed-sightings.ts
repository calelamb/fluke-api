import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const sightingsData = [
  { hoursAgo: 2, lat: 48.5159, lon: -123.1521, location: 'Lime Kiln Point, San Juan Island', ecotype: 'RESIDENT', groupSize: 7, behavior: 'Northbound, foraging behavior, mixed pod members visible at the surface.', whales: [{ catalogId: 'J35', confidence: 'CONFIRMED' }, { catalogId: 'J17', confidence: 'LIKELY' }] },
  { hoursAgo: 5, lat: 48.5650, lon: -123.2400, location: 'Haro Strait', ecotype: 'RESIDENT', groupSize: 5, behavior: 'Slow travel southbound, occasional spy-hopping.', whales: [{ catalogId: 'J16', confidence: 'CONFIRMED' }] },
  { hoursAgo: 8, lat: 48.8702, lon: -123.3120, location: 'Active Pass, BC', ecotype: 'BIGGS', groupSize: 4, behavior: 'Tight matriline group, suspected hunting harbor seals near the rocks.', whales: [{ catalogId: 'T065A2', confidence: 'CONFIRMED' }] },
  { hoursAgo: 14, lat: 48.7500, lon: -123.1500, location: 'Boundary Pass', ecotype: 'BIGGS', groupSize: 3, behavior: 'Quiet travel, mother and two offspring.', whales: [{ catalogId: 'T037A1B', confidence: 'LIKELY' }] },
  { hoursAgo: 22, lat: 48.2978, lon: -123.5314, location: 'Race Rocks, BC', ecotype: 'BIGGS', groupSize: 6, behavior: 'Active hunt observed near sea lion haul-out.', whales: [{ catalogId: 'T049A1', confidence: 'CONFIRMED' }] },
  { hoursAgo: 36, lat: 48.9779, lon: -123.0820, location: 'Point Roberts', ecotype: 'RESIDENT', groupSize: 9, behavior: 'Resting line formation, tight social grouping.', whales: [{ catalogId: 'L87', confidence: 'CONFIRMED' }] },
  { hoursAgo: 48, lat: 47.5762, lon: -122.4131, location: 'Alki Point, West Seattle', ecotype: 'RESIDENT', groupSize: 4, behavior: 'Surface active, breaching observed multiple times.', whales: [] },
  { hoursAgo: 60, lat: 47.8108, lon: -122.3823, location: 'Edmonds ferry route', ecotype: 'RESIDENT', groupSize: 6, behavior: 'Crossed in front of the Edmonds-Kingston ferry, vessels held at distance.', whales: [{ catalogId: 'J26', confidence: 'CONFIRMED' }] },
  { hoursAgo: 72, lat: 48.2390, lon: -122.7290, location: 'West Whidbey Island', ecotype: 'RESIDENT', groupSize: 3, behavior: 'Foraging in kelp beds.', whales: [] },
  { hoursAgo: 96, lat: 48.1170, lon: -122.7604, location: 'Port Townsend', ecotype: 'BIGGS', groupSize: 5, behavior: 'Hunting porpoise, intense surface activity for several minutes.', whales: [] },
  { hoursAgo: 120, lat: 48.0700, lon: -123.0300, location: 'Sequim Bay', ecotype: 'UNKNOWN', groupSize: 2, behavior: 'Brief sighting near the bay mouth, identification uncertain.', whales: [] },
  { hoursAgo: 144, lat: 47.9890, lon: -122.8970, location: 'Discovery Bay', ecotype: 'OFFSHORE', groupSize: 12, behavior: 'Large group, distinctive offshore-type body shapes and worn dorsal fins.', whales: [] },
  { hoursAgo: 168, lat: 48.1820, lon: -123.1620, location: 'Dungeness Spit', ecotype: 'RESIDENT', groupSize: 8, behavior: 'Foraging behavior, multiple successful catches observed.', whales: [{ catalogId: 'J35', confidence: 'LIKELY' }] },
  { hoursAgo: 192, lat: 48.7900, lon: -123.1900, location: 'Saturna Island', ecotype: 'BIGGS', groupSize: 3, behavior: 'Quiet travel along shoreline.', whales: [] },
  { hoursAgo: 240, lat: 48.6790, lon: -122.8950, location: 'East Sound, Orcas Island', ecotype: 'RESIDENT', groupSize: 5, behavior: 'Calm surface travel, mixed adults and juveniles.', whales: [] },
  { hoursAgo: 360, lat: 48.5900, lon: -122.7400, location: 'Rosario Strait', ecotype: 'RESIDENT', groupSize: 7, behavior: 'Northbound foraging behavior.', whales: [{ catalogId: 'L87', confidence: 'LIKELY' }] },
  { hoursAgo: 480, lat: 48.4504, lon: -122.9624, location: 'Cattle Point, San Juan Island', ecotype: 'RESIDENT', groupSize: 4, behavior: 'Brief surface activity then long dive sequence.', whales: [] },
  { hoursAgo: 720, lat: 48.4200, lon: -123.0600, location: 'Salmon Bank', ecotype: 'RESIDENT', groupSize: 6, behavior: 'Active foraging on Chinook salmon.', whales: [{ catalogId: 'J16', confidence: 'LIKELY' }, { catalogId: 'J17', confidence: 'LIKELY' }] },
] as const;

async function main() {
  const catalogIds = ['J35', 'J17', 'J16', 'J26', 'L87', 'T065A2', 'T049A1', 'T037A1B'];
  const whales = await prisma.whale.findMany({
    where: { catalogId: { in: catalogIds } },
    select: { id: true, catalogId: true },
  });
  const whaleIds = new Map(whales.map((whale) => [whale.catalogId, whale.id]));
  const missing = catalogIds.filter((catalogId) => !whaleIds.has(catalogId));

  if (missing.length > 0) {
    throw new Error(`Missing seeded whales: ${missing.join(', ')}. Run pnpm db:seed first.`);
  }

  await prisma.sighting.deleteMany();
  console.log('Deleted existing sightings.');

  const now = Date.now();

  for (const sighting of sightingsData) {
    const created = await prisma.sighting.create({
      data: {
        observedAt: new Date(now - sighting.hoursAgo * 60 * 60 * 1000),
        latitude: sighting.lat,
        longitude: sighting.lon,
        locationName: sighting.location,
        ecotypeGuess: sighting.ecotype,
        groupSize: sighting.groupSize,
        behaviorNotes: sighting.behavior,
        observerEmail: 'seed@fluke.local',
        status: 'APPROVED',
        whales: {
          create: sighting.whales.map((whale) => ({
            whaleId: whaleIds.get(whale.catalogId)!,
            confidence: whale.confidence,
          })),
        },
      },
    });

    console.log(`  ✓ ${created.locationName} (${sighting.whales.length} identified)`);
  }

  console.log(`\nSeeded ${sightingsData.length} sightings successfully.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
