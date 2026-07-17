import type { Prisma, PrismaClient } from '@prisma/client';
import { boundedDatabaseRead } from '../lib/bounded-database-read.js';

const PREDICTION_STATEMENT_TIMEOUT_MS = 30_000;

export type PredictionObservationRow = Readonly<{
  latitude: Prisma.Decimal | number;
  longitude: Prisma.Decimal | number;
  observedAt: Date;
}>;

export type PredictionPod = 'J' | 'K' | 'L' | 'BIGGS';

export interface PredictionObservationReader {
  latestForPod(pod: PredictionPod, signal: AbortSignal): Promise<PredictionObservationRow | null>;
  latestForWhale(whaleId: string, signal: AbortSignal): Promise<PredictionObservationRow | null>;
  seasonalForPod(
    pod: PredictionPod,
    month: number,
    take: number,
    signal: AbortSignal,
  ): Promise<readonly PredictionObservationRow[]>;
  seasonalForWhale(
    whaleId: string,
    month: number,
    take: number,
    signal: AbortSignal,
  ): Promise<readonly PredictionObservationRow[]>;
  whaleIds(
    cursor: string | undefined,
    take: number,
    signal: AbortSignal,
  ): Promise<readonly Readonly<{ id: string }>[]>;
}

function validateMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('prediction month must be an integer from 1 through 12');
  }
}

function validateTake(take: number): void {
  if (!Number.isInteger(take) || take <= 0) {
    throw new Error('prediction read size must be a positive integer');
  }
}

export class PostgresPredictionObservationReader implements PredictionObservationReader {
  readonly #client: PrismaClient;

  constructor(client: PrismaClient) {
    this.#client = client;
  }

  async whaleIds(
    cursor: string | undefined,
    take: number,
    signal: AbortSignal,
  ): Promise<readonly Readonly<{ id: string }>[]> {
    validateTake(take);
    return this.#read((transaction) => transaction.whale.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: { id: true },
      take,
    }), signal);
  }

  async seasonalForWhale(
    whaleId: string,
    month: number,
    take: number,
    signal: AbortSignal,
  ): Promise<readonly PredictionObservationRow[]> {
    validateMonth(month);
    validateTake(take);
    return this.#read((transaction) => transaction.$queryRaw<PredictionObservationRow[]>`
      SELECT
        s."latitude",
        s."longitude",
        s."observed_at" AS "observedAt"
      FROM "sightings" s
      WHERE s."status" = 'APPROVED'
        AND EXTRACT(MONTH FROM s."observed_at") = ${month}
        AND EXISTS (
          SELECT 1
          FROM "sighting_whales" sw
          WHERE sw."sighting_id" = s."id"
            AND sw."whale_id" = ${whaleId}
        )
      ORDER BY s."observed_at" DESC, s."id" DESC
      LIMIT ${take}
    `, signal);
  }

  async latestForWhale(
    whaleId: string,
    signal: AbortSignal,
  ): Promise<PredictionObservationRow | null> {
    return this.#read((transaction) => transaction.sighting.findFirst({
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      select: { latitude: true, longitude: true, observedAt: true },
      where: { status: 'APPROVED', whales: { some: { whaleId } } },
    }), signal);
  }

  async seasonalForPod(
    pod: PredictionPod,
    month: number,
    take: number,
    signal: AbortSignal,
  ): Promise<readonly PredictionObservationRow[]> {
    validateMonth(month);
    validateTake(take);
    return pod === 'BIGGS'
      ? this.#seasonalForBiggs(month, take, signal)
      : this.#seasonalForResidentPod(pod, month, take, signal);
  }

  async latestForPod(
    pod: PredictionPod,
    signal: AbortSignal,
  ): Promise<PredictionObservationRow | null> {
    return pod === 'BIGGS'
      ? this.#latestForBiggs(signal)
      : this.#latestForResidentPod(pod, signal);
  }

  #read<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return boundedDatabaseRead(
      this.#client,
      operation,
      signal,
      PREDICTION_STATEMENT_TIMEOUT_MS,
    );
  }

  #seasonalForBiggs(
    month: number,
    take: number,
    signal: AbortSignal,
  ): Promise<readonly PredictionObservationRow[]> {
    return this.#read((transaction) => transaction.$queryRaw<PredictionObservationRow[]>`
      SELECT observations."latitude", observations."longitude", observations."observedAt"
      FROM (
        SELECT s."id", s."latitude", s."longitude", s."observed_at" AS "observedAt", 0 AS "sourceRank"
        FROM "sightings" s
        WHERE s."status" = 'APPROVED'
          AND EXTRACT(MONTH FROM s."observed_at") = ${month}
          AND EXISTS (
            SELECT 1
            FROM "sighting_whales" sw
            INNER JOIN "whales" w ON w."id" = sw."whale_id"
            WHERE sw."sighting_id" = s."id" AND w."ecotype" = 'BIGGS'
          )
        UNION ALL
        SELECT e."id", e."latitude", e."longitude", e."observed_at" AS "observedAt", 1 AS "sourceRank"
        FROM "external_sightings" e
        WHERE e."ecotype_guess" = 'BIGGS'
          AND EXTRACT(MONTH FROM e."observed_at") = ${month}
      ) observations
      ORDER BY observations."observedAt" DESC, observations."sourceRank", observations."id" DESC
      LIMIT ${take}
    `, signal);
  }

  #seasonalForResidentPod(
    pod: Exclude<PredictionPod, 'BIGGS'>,
    month: number,
    take: number,
    signal: AbortSignal,
  ): Promise<readonly PredictionObservationRow[]> {
    return this.#read((transaction) => transaction.$queryRaw<PredictionObservationRow[]>`
      SELECT observations."latitude", observations."longitude", observations."observedAt"
      FROM (
        SELECT s."id", s."latitude", s."longitude", s."observed_at" AS "observedAt", 0 AS "sourceRank"
        FROM "sightings" s
        WHERE s."status" = 'APPROVED'
          AND EXTRACT(MONTH FROM s."observed_at") = ${month}
          AND EXISTS (
            SELECT 1
            FROM "sighting_whales" sw
            INNER JOIN "whales" w ON w."id" = sw."whale_id"
            WHERE sw."sighting_id" = s."id" AND w."pod" = ${pod}
          )
        UNION ALL
        SELECT e."id", e."latitude", e."longitude", e."observed_at" AS "observedAt", 1 AS "sourceRank"
        FROM "external_sightings" e
        WHERE e."ecotype_guess" = 'RESIDENT'
          AND EXTRACT(MONTH FROM e."observed_at") = ${month}
      ) observations
      ORDER BY observations."observedAt" DESC, observations."sourceRank", observations."id" DESC
      LIMIT ${take}
    `, signal);
  }

  #latestForBiggs(signal: AbortSignal): Promise<PredictionObservationRow | null> {
    return this.#read((transaction) => transaction.$queryRaw<PredictionObservationRow[]>`
      SELECT observations."latitude", observations."longitude", observations."observedAt"
      FROM (
        SELECT s."id", s."latitude", s."longitude", s."observed_at" AS "observedAt", 0 AS "sourceRank"
        FROM "sightings" s
        WHERE s."status" = 'APPROVED'
          AND EXISTS (
            SELECT 1
            FROM "sighting_whales" sw
            INNER JOIN "whales" w ON w."id" = sw."whale_id"
            WHERE sw."sighting_id" = s."id" AND w."ecotype" = 'BIGGS'
          )
        UNION ALL
        SELECT e."id", e."latitude", e."longitude", e."observed_at" AS "observedAt", 1 AS "sourceRank"
        FROM "external_sightings" e
        WHERE e."ecotype_guess" = 'BIGGS'
      ) observations
      ORDER BY observations."observedAt" DESC, observations."sourceRank", observations."id" DESC
      LIMIT 1
    `, signal).then((rows) => rows[0] ?? null);
  }

  #latestForResidentPod(
    pod: Exclude<PredictionPod, 'BIGGS'>,
    signal: AbortSignal,
  ): Promise<PredictionObservationRow | null> {
    return this.#read((transaction) => transaction.$queryRaw<PredictionObservationRow[]>`
      SELECT observations."latitude", observations."longitude", observations."observedAt"
      FROM (
        SELECT s."id", s."latitude", s."longitude", s."observed_at" AS "observedAt", 0 AS "sourceRank"
        FROM "sightings" s
        WHERE s."status" = 'APPROVED'
          AND EXISTS (
            SELECT 1
            FROM "sighting_whales" sw
            INNER JOIN "whales" w ON w."id" = sw."whale_id"
            WHERE sw."sighting_id" = s."id" AND w."pod" = ${pod}
          )
        UNION ALL
        SELECT e."id", e."latitude", e."longitude", e."observed_at" AS "observedAt", 1 AS "sourceRank"
        FROM "external_sightings" e
        WHERE e."ecotype_guess" = 'RESIDENT'
      ) observations
      ORDER BY observations."observedAt" DESC, observations."sourceRank", observations."id" DESC
      LIMIT 1
    `, signal).then((rows) => rows[0] ?? null);
  }
}
