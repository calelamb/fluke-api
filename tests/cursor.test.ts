import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  ExternalSightingCursorSchema,
  WhaleCursorSchema,
} from '../src/lib/cursor.js';

function deterministicNoise(length: number, namespace: string): string {
  const chunks: string[] = [];
  for (let index = 0; chunks.join('').length < length; index += 1) {
    chunks.push(createHash('sha256').update(`${namespace}-${index}`).digest('base64url'));
  }
  return chunks.join('').slice(0, length);
}

describe('opaque cursor codec', () => {
  it('round-trips a maximum-size external cursor within the public 512-character bound', () => {
    const observedAt = new Date();
    const since = new Date(observedAt.getTime() - 7 * 24 * 60 * 60 * 1_000);
    const payload = {
      id: deterministicNoise(200, 'id'),
      kind: 'external-sightings' as const,
      observedAt: observedAt.toISOString(),
      since: since.toISOString(),
      sinceDays: 31,
      source: deterministicNoise(100, 'source'),
      version: 1 as const,
    };

    const cursor = encodeCursor(payload);

    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(decodeCursor(cursor, ExternalSightingCursorSchema)).toEqual(payload);
  });

  it('rejects a valid cursor when it belongs to another route', () => {
    const cursor = encodeCursor({
      id: 'external-id',
      kind: 'external-sightings',
      observedAt: '2026-07-16T18:00:00.000Z',
      since: '2026-07-09T18:00:00.000Z',
      sinceDays: 7,
      source: null,
      version: 1,
    });

    expect(() => decodeCursor(cursor, WhaleCursorSchema)).toThrow('Invalid pagination cursor');
  });
});
