import type { Prisma, PrismaClient } from '@prisma/client';
import {
  cellToCoord,
  computeTransitions,
  confidenceFor,
  gridCell,
  predictNext,
} from '../services/prediction-engine.js';
import type { JobLease, JobSummary } from './job-runner.js';

const MODEL_VERSION = 'markov-v1';
const HORIZONS = Object.freeze([24, 168, 720] as const);
const PODS = Object.freeze(['J', 'K', 'L', 'BIGGS'] as const);
const TOP_N = 30;

type Observation = Readonly<{ latitude: number; longitude: number; observedAt: Date }>;

interface FencedPredictionWriter {
  runFenced<T>(
    lease: JobLease,
    operation: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface PredictionJobOptions {
  readonly client: PrismaClient;
  readonly lease: JobLease;
  readonly now?: Date;
  readonly signal: AbortSignal;
  readonly store: FencedPredictionWriter;
}

function predictionArgs(
  kind: 'POD' | 'WHALE',
  id: string,
  observations: readonly Observation[],
  now: Date,
): Prisma.PredictionGridUpsertArgs[] {
  if (observations.length === 0) return [];
  const targetMonth = now.getUTCMonth() + 1;
  const matrix = computeTransitions([...observations], targetMonth);
  const last = observations.at(-1);
  if (!last) return [];
  const predicted = predictNext({
    currentCell: gridCell(last.latitude, last.longitude),
    matrix,
    topN: TOP_N,
  });
  const cells = predicted.map(({ cell, probability }) => ({
    ...cellToCoord(cell),
    probability,
  }));
  const confidence = confidenceFor(observations.filter(
    (item) => item.observedAt.getUTCMonth() + 1 === targetMonth,
  ).length);
  return HORIZONS.map((horizonHours) => {
    const values = { cells, confidence, computedAt: now, modelVersion: MODEL_VERSION };
    return {
      create: { ...values, horizonHours, subjectId: id, subjectKind: kind },
      update: values,
      where: {
        subjectKind_subjectId_horizonHours: {
          horizonHours,
          subjectId: id,
          subjectKind: kind,
        },
      },
    };
  });
}

function observations(
  rows: readonly Readonly<{ latitude: Prisma.Decimal | number; longitude: Prisma.Decimal | number; observedAt: Date }>[],
): Observation[] {
  return rows.map((row) => Object.freeze({
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    observedAt: row.observedAt,
  }));
}

async function whalePredictions(client: PrismaClient, now: Date): Promise<Prisma.PredictionGridUpsertArgs[]> {
  const whales = await client.whale.findMany({ select: { id: true } });
  const groups = await Promise.all(whales.map(async (whale) => {
    const rows = await client.sighting.findMany({
      orderBy: { observedAt: 'asc' },
      select: { latitude: true, longitude: true, observedAt: true },
      where: { status: 'APPROVED', whales: { some: { whaleId: whale.id } } },
    });
    return predictionArgs('WHALE', whale.id, observations(rows), now);
  }));
  return groups.flat();
}

async function podPredictions(client: PrismaClient, now: Date): Promise<Prisma.PredictionGridUpsertArgs[]> {
  const groups = await Promise.all(PODS.map(async (pod) => {
    const whale: Prisma.WhaleWhereInput = pod === 'BIGGS' ? { ecotype: 'BIGGS' } : { pod };
    const [approved, external] = await Promise.all([
      client.sighting.findMany({
        orderBy: { observedAt: 'asc' },
        select: { latitude: true, longitude: true, observedAt: true },
        where: { status: 'APPROVED', whales: { some: { whale } } },
      }),
      client.externalSighting.findMany({
        orderBy: { observedAt: 'asc' },
        select: { latitude: true, longitude: true, observedAt: true },
        where: { ecotypeGuess: pod === 'BIGGS' ? 'BIGGS' : 'RESIDENT' },
      }),
    ]);
    const combined = [...observations(approved), ...observations(external)];
    combined.sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
    return predictionArgs('POD', pod, combined, now);
  }));
  return groups.flat();
}

export async function runPredictionJob(options: PredictionJobOptions): Promise<JobSummary> {
  const now = options.now ?? new Date();
  const [whaleRows, podRows] = await Promise.all([
    whalePredictions(options.client, now),
    podPredictions(options.client, now),
  ]);
  if (options.signal.aborted) throw options.signal.reason;
  const writes = [...whaleRows, ...podRows];
  await options.store.runFenced(options.lease, async (client) => {
    for (const args of writes) await client.predictionGrid.upsert(args);
  });
  return Object.freeze({ modelVersion: MODEL_VERSION, processed: writes.length });
}
