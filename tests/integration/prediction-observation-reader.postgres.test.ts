import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPredictionObservationReader } from '../../src/jobs/prediction-observation-reader.js';

const postgresEnabled = process.env.RUN_POSTGRES_INTEGRATION === 'true';
const suffix = randomUUID();
const fixture = Object.freeze({
  catalogId: `IT-PREDICTION-${suffix}`,
  externalId: `it-prediction-external-${suffix}`,
  sightingId: `it-prediction-sighting-${suffix}`,
  whaleId: `it-prediction-whale-${suffix}`,
});

describe.runIf(postgresEnabled)('prediction observation reads against PostgreSQL', () => {
  let prisma: typeof import('../../src/db.js')['prisma'];
  let reader: PostgresPredictionObservationReader;
  const observedAt = new Date();

  beforeAll(async () => {
    ({ prisma } = await import('../../src/db.js'));
    reader = new PostgresPredictionObservationReader(prisma);
    await prisma.whale.create({
      data: {
        catalogId: fixture.catalogId,
        ecotype: 'RESIDENT',
        id: fixture.whaleId,
        pod: 'J',
      },
    });
    await prisma.sighting.create({
      data: {
        id: fixture.sightingId,
        latitude: 48.51,
        longitude: -123.01,
        observedAt,
        observerEmail: 'prediction-integration@example.invalid',
        status: 'APPROVED',
        whales: { create: { confidence: 'CONFIRMED', whaleId: fixture.whaleId } },
      },
    });
    await prisma.externalSighting.create({
      data: {
        attribution: 'Prediction integration fixture',
        ecotypeGuess: 'RESIDENT',
        externalId: fixture.externalId,
        id: fixture.externalId,
        latitude: 48.61,
        longitude: -123.11,
        observedAt,
        source: 'integration',
        species: 'Orcinus orca',
        trusted: true,
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.sighting.deleteMany({ where: { id: fixture.sightingId } });
      await prisma.externalSighting.deleteMany({ where: { id: fixture.externalId } });
      await prisma.whale.deleteMany({ where: { id: fixture.whaleId } });
      await prisma.$disconnect();
    }
  });

  it('executes bounded seasonal and latest whale queries', async () => {
    const signal = new AbortController().signal;
    const month = observedAt.getUTCMonth() + 1;

    const seasonal = await reader.seasonalForWhale(fixture.whaleId, month, 10, signal);
    const latest = await reader.latestForWhale(fixture.whaleId, signal);

    expect(seasonal.some((row) => Number(row.latitude) === 48.51)).toBe(true);
    expect(Number(latest?.latitude)).toBe(48.51);
  });

  it('executes deterministic resident and Bigg\'s pod unions', async () => {
    const signal = new AbortController().signal;
    const month = observedAt.getUTCMonth() + 1;

    const resident = await reader.seasonalForPod('J', month, 100, signal);
    const latest = await reader.latestForPod('J', signal);

    expect(resident.some((row) => Number(row.latitude) === 48.51)).toBe(true);
    expect(resident.some((row) => Number(row.latitude) === 48.61)).toBe(true);
    expect(latest).not.toBeNull();
    await expect(reader.seasonalForPod('BIGGS', month, 1, signal)).resolves.toBeDefined();
    await expect(reader.latestForPod('BIGGS', signal)).resolves.toBeDefined();
  });
});
