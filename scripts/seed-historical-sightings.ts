import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Hotspot {
  name: string;
  lat: number;
  lng: number;
  podWeight: { J: number; K: number; L: number; BIGGS: number };
}

const HOTSPOTS: Hotspot[] = [
  { name: 'Lime Kiln Point', lat: 48.516, lng: -123.152, podWeight: { J: 0.45, K: 0.25, L: 0.2, BIGGS: 0.1 } },
  { name: 'Boundary Pass', lat: 48.75, lng: -123.05, podWeight: { J: 0.4, K: 0.3, L: 0.2, BIGGS: 0.1 } },
  { name: 'Haro Strait', lat: 48.55, lng: -123.2, podWeight: { J: 0.5, K: 0.2, L: 0.2, BIGGS: 0.1 } },
  { name: 'Active Pass', lat: 48.86, lng: -123.31, podWeight: { J: 0.35, K: 0.25, L: 0.25, BIGGS: 0.15 } },
  { name: 'Rosario Strait', lat: 48.5, lng: -122.78, podWeight: { J: 0.2, K: 0.2, L: 0.15, BIGGS: 0.45 } },
  { name: 'Saratoga Passage', lat: 48.18, lng: -122.55, podWeight: { J: 0.25, K: 0.2, L: 0.2, BIGGS: 0.35 } },
  { name: 'Admiralty Inlet', lat: 48.16, lng: -122.78, podWeight: { J: 0.2, K: 0.2, L: 0.15, BIGGS: 0.45 } },
  { name: 'Possession Sound', lat: 47.95, lng: -122.32, podWeight: { J: 0.15, K: 0.15, L: 0.15, BIGGS: 0.55 } },
  { name: 'Hood Canal', lat: 47.65, lng: -122.95, podWeight: { J: 0.1, K: 0.1, L: 0.1, BIGGS: 0.7 } },
  { name: 'Strait of Juan de Fuca', lat: 48.27, lng: -123.95, podWeight: { J: 0.3, K: 0.3, L: 0.3, BIGGS: 0.1 } },
  { name: 'San Juan Islands', lat: 48.42, lng: -123.0, podWeight: { J: 0.4, K: 0.25, L: 0.2, BIGGS: 0.15 } },
  { name: 'Puget Sound', lat: 47.6, lng: -122.45, podWeight: { J: 0.15, K: 0.15, L: 0.15, BIGGS: 0.55 } },
];

function jitter(value: number, range: number): number {
  return value + (Math.random() - 0.5) * range;
}

function pickHotspotForPod(pod: 'J' | 'K' | 'L' | 'BIGGS'): Hotspot {
  const totalWeight = HOTSPOTS.reduce((s, h) => s + h.podWeight[pod], 0);
  let r = Math.random() * totalWeight;
  for (const h of HOTSPOTS) {
    r -= h.podWeight[pod];
    if (r <= 0) return h;
  }
  return HOTSPOTS[0];
}

function seasonalWeight(month: number, pod: 'J' | 'K' | 'L' | 'BIGGS'): number {
  if (pod === 'BIGGS') return 0.6 + 0.4 * Math.sin(((month - 3) / 12) * Math.PI * 2);
  return 0.3 + 0.7 * Math.exp(-Math.pow((month - 6) / 3, 2));
}

async function main() {
  const start = Date.now();
  console.log('seed-historical-sightings: starting...');

  const existing = await prisma.sighting.count({ where: { status: 'APPROVED' } });
  console.log(`  existing approved sightings: ${existing}`);

  const whales = await prisma.whale.findMany({
    select: { id: true, catalogId: true, pod: true },
  });

  const podWhales: Record<string, typeof whales> = { J: [], K: [], L: [], BIGGS: [] };
  for (const w of whales) {
    if (w.pod && w.pod in podWhales) podWhales[w.pod].push(w);
  }

  console.log('  whale counts by pod:', Object.fromEntries(Object.entries(podWhales).map(([p, ws]) => [p, ws.length])));

  if (Object.values(podWhales).every((arr) => arr.length === 0)) {
    console.error('  no whales with pod set; aborting');
    process.exit(1);
  }

  const now = new Date();
  const eighteenMonthsAgo = new Date(now.getTime() - 18 * 30 * 24 * 60 * 60 * 1000);
  const totalDays = Math.floor((now.getTime() - eighteenMonthsAgo.getTime()) / (24 * 60 * 60 * 1000));

  const sightingsToCreate: Array<{
    sighting: {
      observedAt: Date;
      latitude: number;
      longitude: number;
      locationName: string;
      ecotypeGuess: 'RESIDENT' | 'BIGGS';
      groupSize: number;
      observerEmail: string;
      status: 'APPROVED';
      moderatedAt: Date;
    };
    whaleIds: string[];
  }> = [];

  const pods: Array<'J' | 'K' | 'L' | 'BIGGS'> = ['J', 'K', 'L', 'BIGGS'];
  const SIGHTINGS_PER_POD_PER_MONTH = 8;

  for (const pod of pods) {
    if (podWhales[pod].length === 0) continue;
    for (let day = 0; day < totalDays; day++) {
      const date = new Date(eighteenMonthsAgo.getTime() + day * 24 * 60 * 60 * 1000);
      const month = date.getUTCMonth();
      const probability = (seasonalWeight(month, pod) * SIGHTINGS_PER_POD_PER_MONTH) / 30;
      if (Math.random() > probability) continue;

      const hotspot = pickHotspotForPod(pod);
      const lat = jitter(hotspot.lat, 0.04);
      const lng = jitter(hotspot.lng, 0.06);
      const observedAt = new Date(date.getTime() + Math.random() * 24 * 60 * 60 * 1000);

      const whalesInPod = podWhales[pod];
      const groupSize = pod === 'BIGGS'
        ? 2 + Math.floor(Math.random() * 4)
        : 3 + Math.floor(Math.random() * 8);
      const linkCount = Math.min(whalesInPod.length, 1 + Math.floor(Math.random() * 3));
      const shuffled = [...whalesInPod].sort(() => Math.random() - 0.5);
      const whaleIds = shuffled.slice(0, linkCount).map((w) => w.id);

      sightingsToCreate.push({
        sighting: {
          observedAt,
          latitude: lat,
          longitude: lng,
          locationName: hotspot.name,
          ecotypeGuess: pod === 'BIGGS' ? 'BIGGS' : 'RESIDENT',
          groupSize,
          observerEmail: 'seed@fluke.local',
          status: 'APPROVED',
          moderatedAt: observedAt,
        },
        whaleIds,
      });
    }
  }

  console.log(`  generating ${sightingsToCreate.length} sightings...`);

  const BATCH_SIZE = 50;
  let created = 0;
  for (let i = 0; i < sightingsToCreate.length; i += BATCH_SIZE) {
    const batch = sightingsToCreate.slice(i, i + BATCH_SIZE);
    await prisma.$transaction(
      batch.map(({ sighting, whaleIds }) =>
        prisma.sighting.create({
          data: {
            ...sighting,
            whales: {
              create: whaleIds.map((whaleId) => ({
                whaleId,
                confidence: 'CONFIRMED',
              })),
            },
          },
        }),
      ),
    );
    created += batch.length;
    if (created % 200 === 0 || created === sightingsToCreate.length) {
      console.log(`    ${created}/${sightingsToCreate.length}`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`seed-historical-sightings: done. created ${created} sightings in ${elapsed}s`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
