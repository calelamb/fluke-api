import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { IsoDateTimeSchema } from '../contracts/index.js';
import { env } from '../env.js';
import { InvalidCursorError } from './cursor.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const DECIMAL_REVISION = /^(?:0|[1-9][0-9]*)$/u;
const MAX_PUBLIC_REVISION = BigInt(Number.MAX_SAFE_INTEGER);

const RevisionStringSchema = z.string()
  .regex(DECIMAL_REVISION)
  .refine((value) => BigInt(value) <= MAX_PUBLIC_REVISION, 'revision is too large');

export const FeedPageCursorSchema = z.object({
  kind: z.literal('sighting-feed-page'),
  observedAt: IsoDateTimeSchema,
  revision: RevisionStringSchema,
  snapshotRevision: RevisionStringSchema,
  version: z.literal(1),
}).strict().refine(
  (value) => BigInt(value.snapshotRevision) >= BigInt(value.revision),
  'snapshot revision must include the page revision',
);

export const FeedSyncCursorSchema = z.object({
  kind: z.literal('sighting-feed-sync'),
  revision: RevisionStringSchema,
  version: z.literal(1),
}).strict();

export interface FeedPageCursorInput {
  readonly observedAt: string;
  readonly revision: bigint;
  readonly snapshotRevision: bigint;
}

export interface DecodedFeedPageCursor {
  readonly observedAt: string;
  readonly revision: bigint;
  readonly snapshotRevision: bigint;
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function encodeSignedCursor(value: Readonly<Record<string, unknown>>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

function decodeSignedCursor(cursor: string, secret: string): unknown {
  const [payload, suppliedSignature, extra] = cursor.split('.');
  if (
    extra !== undefined
    || payload === undefined
    || suppliedSignature === undefined
    || !BASE64URL.test(payload)
    || !BASE64URL.test(suppliedSignature)
  ) {
    throw new InvalidCursorError();
  }

  const expected = Buffer.from(signature(payload, secret), 'base64url');
  const supplied = Buffer.from(suppliedSignature, 'base64url');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new InvalidCursorError();
  }

  try {
    const decoded = Buffer.from(payload, 'base64url');
    if (decoded.toString('base64url') !== payload || decoded.byteLength > 1_024) {
      throw new InvalidCursorError();
    }
    return JSON.parse(decoded.toString('utf8')) as unknown;
  } catch (error: unknown) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError();
  }
}

export function encodeFeedPageCursor(
  cursor: FeedPageCursorInput,
  secret = env.JWT_SECRET,
): string {
  return encodeSignedCursor({
    kind: 'sighting-feed-page',
    observedAt: cursor.observedAt,
    revision: cursor.revision.toString(),
    snapshotRevision: cursor.snapshotRevision.toString(),
    version: 1,
  }, secret);
}

export function decodeFeedPageCursor(
  cursor: string,
  secret = env.JWT_SECRET,
): DecodedFeedPageCursor {
  const parsed = FeedPageCursorSchema.safeParse(decodeSignedCursor(cursor, secret));
  if (!parsed.success) throw new InvalidCursorError();
  return Object.freeze({
    observedAt: parsed.data.observedAt,
    revision: BigInt(parsed.data.revision),
    snapshotRevision: BigInt(parsed.data.snapshotRevision),
  });
}

export function encodeFeedSyncCursor(revision: bigint, secret = env.JWT_SECRET): string {
  return encodeSignedCursor({
    kind: 'sighting-feed-sync',
    revision: revision.toString(),
    version: 1,
  }, secret);
}

export function decodeFeedSyncCursor(cursor: string, secret = env.JWT_SECRET): bigint {
  const parsed = FeedSyncCursorSchema.safeParse(decodeSignedCursor(cursor, secret));
  if (!parsed.success) throw new InvalidCursorError();
  return BigInt(parsed.data.revision);
}
