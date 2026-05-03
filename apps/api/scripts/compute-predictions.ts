import { PrismaClient } from '@prisma/client';
import {
  computeTransitions,
  predictNext,
  gridCell,
  cellToCoord,
  confidenceFor,
} from '../src/services/prediction-engine.js';

const MODEL_VERSION = 'markov-v1';
const HORIZONS = [24, 168, 720]; // hours: 24h, 7d, 30d
const TOP_N = 30;

async function main() {
  const prisma = new PrismaClient();

  console.log('[predict] computing per-whale predictions...');
  const whales = await prisma.whale.findMany({
    select: { id: true, pod: true, ecotype: true },
  });

  for (const whale of whales) {
    const sightings = await prisma.sighting.findMany({
      where: {
        status: 'APPROVED',
        whales: { some: { whaleId: whale.id } },
      },
      orderBy: { observedAt: 'asc' },
      select: { observedAt: true, latitude: true, longitude: true },
    });
    const sightingsConverted = sightings.map((s) => ({
      observedAt: s.observedAt,
      latitude: Number(s.latitude),
      longitude: Number(s.longitude),
    }));

    if (sightingsConverted.length === 0) continue;

    const targetMonth = new Date().getUTCMonth() + 1;
    const matrix = computeTransitions(sightingsConverted, targetMonth);
    const lastSighting = sightingsConverted[sightingsConverted.length - 1];
    const currentCell = gridCell(lastSighting.latitude, lastSighting.longitude);
    const monthMatchedCount = sightingsConverted.filter(
      (s) => s.observedAt.getUTCMonth() + 1 === targetMonth
    ).length;
    const confidence = confidenceFor(monthMatchedCount);
    const topCells = predictNext({ currentCell, matrix, topN: TOP_N });

    const cells = topCells.map(({ cell, probability }) => {
      const { lat, lng } = cellToCoord(cell);
      return { lat, lng, probability };
    });

    for (const horizonHours of HORIZONS) {
      await prisma.predictionGrid.upsert({
        where: {
          subjectKind_subjectId_horizonHours: {
            subjectKind: 'WHALE',
            subjectId: whale.id,
            horizonHours,
          },
        },
        update: {
          cells,
          confidence,
          modelVersion: MODEL_VERSION,
          computedAt: new Date(),
        },
        create: {
          subjectKind: 'WHALE',
          subjectId: whale.id,
          horizonHours,
          cells,
          confidence,
          modelVersion: MODEL_VERSION,
          computedAt: new Date(),
        },
      });
    }
  }

  console.log('[predict] computing per-pod predictions...');
  for (const pod of ['J', 'K', 'L', 'BIGGS']) {
    const podWhereClause: any =
      pod === 'BIGGS'
        ? { ecotype: 'BIGGS' }
        : { pod };
    const userSightings = await prisma.sighting.findMany({
      where: {
        status: 'APPROVED',
        whales: {
          some: {
            whale: podWhereClause,
          },
        },
      },
      orderBy: { observedAt: 'asc' },
      select: { observedAt: true, latitude: true, longitude: true },
    });

    // Augment with external sightings filtered by ecotype. J/K/L all map
    // to RESIDENT in the public datasets; BIGGS maps to BIGGS.
    const externalEcotype = pod === 'BIGGS' ? 'BIGGS' : 'RESIDENT';
    const externalSightings = await prisma.externalSighting.findMany({
      where: { ecotypeGuess: externalEcotype },
      orderBy: { observedAt: 'asc' },
      select: { observedAt: true, latitude: true, longitude: true },
    });

    const sightingsConverted = [
      ...userSightings.map((s) => ({
        observedAt: s.observedAt,
        latitude: Number(s.latitude),
        longitude: Number(s.longitude),
      })),
      ...externalSightings.map((s) => ({
        observedAt: s.observedAt,
        latitude: Number(s.latitude),
        longitude: Number(s.longitude),
      })),
    ].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

    if (sightingsConverted.length === 0) continue;
    console.log(`  [${pod}] ${userSightings.length} user + ${externalSightings.length} external = ${sightingsConverted.length} total sightings`);

    const targetMonth = new Date().getUTCMonth() + 1;
    const matrix = computeTransitions(sightingsConverted, targetMonth);
    const last = sightingsConverted[sightingsConverted.length - 1];
    const currentCell = gridCell(last.latitude, last.longitude);
    const monthMatchedCount = sightingsConverted.filter(
      (s) => s.observedAt.getUTCMonth() + 1 === targetMonth
    ).length;
    const confidence = confidenceFor(monthMatchedCount);
    const topCells = predictNext({ currentCell, matrix, topN: TOP_N });
    const cells = topCells.map(({ cell, probability }) => {
      const { lat, lng } = cellToCoord(cell);
      return { lat, lng, probability };
    });

    for (const horizonHours of HORIZONS) {
      await prisma.predictionGrid.upsert({
        where: {
          subjectKind_subjectId_horizonHours: {
            subjectKind: 'POD',
            subjectId: pod,
            horizonHours,
          },
        },
        update: { cells, confidence, modelVersion: MODEL_VERSION, computedAt: new Date() },
        create: {
          subjectKind: 'POD',
          subjectId: pod,
          horizonHours,
          cells,
          confidence,
          modelVersion: MODEL_VERSION,
          computedAt: new Date(),
        },
      });
    }
  }

  await prisma.$disconnect();
  console.log('[predict] done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
