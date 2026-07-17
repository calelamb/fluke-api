import type { Prisma, PrismaClient } from '@prisma/client';
import {
  cellToCoord,
  computeTransitions,
  confidenceFor,
  gridCell,
  predictNext,
} from '../services/prediction-engine.js';
import type { JobLease, JobSummary } from './job-runner.js';
import {
  PostgresPredictionObservationReader,
  type PredictionObservationReader,
  type PredictionObservationRow,
  type PredictionPod,
} from './prediction-observation-reader.js';

const MODEL_VERSION = 'markov-v1';
const HORIZONS = Object.freeze([24, 168, 720] as const);
const PODS = Object.freeze(['J', 'K', 'L', 'BIGGS'] as const satisfies readonly PredictionPod[]);
const TOP_N = 30;
const WHALE_PAGE_SIZE = 100;
const MAX_WHALES = 5_000;
const MAX_OBSERVATIONS_PER_SUBJECT = 5_000;
const WRITE_BATCH_SIZE = 100;

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
  readonly reader?: PredictionObservationReader;
  readonly signal: AbortSignal;
  readonly store: FencedPredictionWriter;
}

function predictionArgs(
  kind: 'POD' | 'WHALE',
  id: string,
  observations: readonly Observation[],
  latest: Observation,
  now: Date,
): Prisma.PredictionGridUpsertArgs[] {
  if (observations.length === 0) return [];
  const targetMonth = now.getUTCMonth() + 1;
  const matrix = computeTransitions([...observations], targetMonth);
  const predicted = predictNext({
    currentCell: gridCell(latest.latitude, latest.longitude),
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

function observation(row: PredictionObservationRow): Observation {
  return Object.freeze({
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    observedAt: row.observedAt,
  });
}

function observations(
  rows: readonly PredictionObservationRow[],
): Observation[] {
  return rows.map(observation);
}

async function whaleIds(
  reader: PredictionObservationReader,
  signal: AbortSignal,
  cursor?: string,
  accumulated: readonly string[] = [],
): Promise<readonly string[]> {
  signal.throwIfAborted();
  const rows = await reader.whaleIds(cursor, WHALE_PAGE_SIZE + 1, signal);
  signal.throwIfAborted();

  const page = rows.slice(0, WHALE_PAGE_SIZE).map(({ id }) => id);
  const next = [...accumulated, ...page];
  const hasMore = rows.length > WHALE_PAGE_SIZE;
  if (next.length > MAX_WHALES || (next.length === MAX_WHALES && hasMore)) {
    throw new Error(`Prediction job exceeds ${MAX_WHALES} whales`);
  }
  if (!hasMore) return next;
  const nextCursor = page.at(-1);
  if (!nextCursor) throw new Error('Prediction whale pagination did not advance');
  return whaleIds(reader, signal, nextCursor, next);
}

function boundedHistory(
  rows: readonly PredictionObservationRow[],
  subject: string,
): readonly Observation[] {
  if (rows.length > MAX_OBSERVATIONS_PER_SUBJECT) {
    throw new Error(`Prediction history for ${subject} exceeds ${MAX_OBSERVATIONS_PER_SUBJECT} rows`);
  }
  return observations([...rows].reverse());
}

async function whalePredictions(
  reader: PredictionObservationReader,
  ids: readonly string[],
  now: Date,
  signal: AbortSignal,
): Promise<Prisma.PredictionGridUpsertArgs[]> {
  signal.throwIfAborted();
  if (ids.length === 0) return [];
  if (ids.length === 1) {
    const id = ids[0];
    const targetMonth = now.getUTCMonth() + 1;
    const rows = await reader.seasonalForWhale(
      id,
      targetMonth,
      MAX_OBSERVATIONS_PER_SUBJECT + 1,
      signal,
    );
    signal.throwIfAborted();
    const latestRow = await reader.latestForWhale(id, signal);
    signal.throwIfAborted();
    if (!latestRow) return [];
    const history = boundedHistory(rows, `whale ${id}`);
    return predictionArgs('WHALE', id, history, observation(latestRow), now);
  }
  const midpoint = Math.floor(ids.length / 2);
  const left = await whalePredictions(reader, ids.slice(0, midpoint), now, signal);
  const right = await whalePredictions(reader, ids.slice(midpoint), now, signal);
  return [...left, ...right];
}

async function podPrediction(
  reader: PredictionObservationReader,
  pod: PredictionPod,
  now: Date,
  signal: AbortSignal,
): Promise<Prisma.PredictionGridUpsertArgs[]> {
  signal.throwIfAborted();
  const targetMonth = now.getUTCMonth() + 1;
  const rows = await reader.seasonalForPod(
    pod,
    targetMonth,
    MAX_OBSERVATIONS_PER_SUBJECT + 1,
    signal,
  );
  signal.throwIfAborted();
  const latestRow = await reader.latestForPod(pod, signal);
  signal.throwIfAborted();
  if (!latestRow) return [];
  const history = boundedHistory(rows, `pod ${pod}`);
  return predictionArgs('POD', pod, history, observation(latestRow), now);
}

async function podPredictions(
  reader: PredictionObservationReader,
  pods: readonly PredictionPod[],
  now: Date,
  signal: AbortSignal,
): Promise<Prisma.PredictionGridUpsertArgs[]> {
  if (pods.length === 0) return [];
  const [pod, ...remaining] = pods;
  const current = await podPrediction(reader, pod, now, signal);
  const rest = await podPredictions(reader, remaining, now, signal);
  return [...current, ...rest];
}

async function writePredictions(
  writes: readonly Prisma.PredictionGridUpsertArgs[],
  options: PredictionJobOptions,
  offset = 0,
): Promise<void> {
  options.signal.throwIfAborted();
  const batch = writes.slice(offset, offset + WRITE_BATCH_SIZE);
  if (batch.length === 0) return;
  await options.store.runFenced(options.lease, async (client) => {
    for (const args of batch) {
      options.signal.throwIfAborted();
      await client.predictionGrid.upsert(args);
    }
  });
  options.signal.throwIfAborted();
  await writePredictions(writes, options, offset + batch.length);
}

export async function runPredictionJob(options: PredictionJobOptions): Promise<JobSummary> {
  const now = options.now ?? new Date();
  const reader = options.reader ?? new PostgresPredictionObservationReader(options.client);
  options.signal.throwIfAborted();
  const ids = await whaleIds(reader, options.signal);
  const whaleRows = await whalePredictions(reader, ids, now, options.signal);
  const podRows = await podPredictions(reader, PODS, now, options.signal);
  const writes = [...whaleRows, ...podRows];
  await writePredictions(writes, options);
  return Object.freeze({ modelVersion: MODEL_VERSION, processed: writes.length });
}
