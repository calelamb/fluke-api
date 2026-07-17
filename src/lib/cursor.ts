import { z, type ZodType } from 'zod';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { IsoDateTimeSchema, PodSchema, StableIdSchema } from '../contracts/index.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export class InvalidCursorError extends Error {
  readonly statusCode = 400;

  constructor() {
    super('Invalid pagination cursor');
    this.name = 'InvalidCursorError';
  }
}

const baseCursor = {
  id: StableIdSchema,
  version: z.literal(1),
} as const;

export const WhaleCursorSchema = z.object({
  ...baseCursor,
  catalogId: StableIdSchema,
  kind: z.literal('whales'),
}).strict();

export const SightingCursorSchema = z.object({
  ...baseCursor,
  kind: z.literal('sightings'),
  observedAt: IsoDateTimeSchema,
}).strict();

export const ExternalSightingCursorSchema = z.object({
  ...baseCursor,
  kind: z.literal('external-sightings'),
  observedAt: IsoDateTimeSchema,
  since: IsoDateTimeSchema,
  sinceDays: z.number().int().min(1).max(31),
  source: z.string().min(1).max(100).nullable(),
}).strict();

export const HistoricalSightingCursorSchema = z.object({
  ...baseCursor,
  from: IsoDateTimeSchema,
  kind: z.literal('historical-sightings'),
  observedAt: IsoDateTimeSchema,
  pod: PodSchema.nullable(),
  source: z.enum(['internal', 'external']),
  to: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  const from = Date.parse(value.from);
  const to = Date.parse(value.to);
  if (from > to || to - from > 366 * 24 * 60 * 60 * 1_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'historical cursor date window is invalid',
      path: ['from'],
    });
  }
});

export type WhaleCursor = z.infer<typeof WhaleCursorSchema>;
export type SightingCursor = z.infer<typeof SightingCursorSchema>;
export type ExternalSightingCursor = z.infer<typeof ExternalSightingCursorSchema>;
export type HistoricalSightingCursor = z.infer<typeof HistoricalSightingCursorSchema>;

export function encodeCursor(value: Readonly<Record<string, unknown>>): string {
  return deflateRawSync(Buffer.from(JSON.stringify(value), 'utf8'), { level: 9 })
    .toString('base64url');
}

export function decodeCursor<T>(cursor: string, schema: ZodType<T>): T {
  if (!BASE64URL.test(cursor)) {
    throw new InvalidCursorError();
  }

  try {
    const compressed = Buffer.from(cursor, 'base64url');
    if (compressed.toString('base64url') !== cursor) {
      throw new InvalidCursorError();
    }
    const decoded = inflateRawSync(compressed, { maxOutputLength: 2_048 });
    const parsed = schema.safeParse(JSON.parse(decoded.toString('utf8')));
    if (!parsed.success) {
      throw new InvalidCursorError();
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw error;
    }
    throw new InvalidCursorError();
  }
}
