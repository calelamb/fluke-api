import { createHash } from 'node:crypto';
import type { SubmitSightingPayload } from '../contracts/index.js';
import type { ObserverPrincipal } from './observer-auth.js';

export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Idempotency key conflict');
    this.name = 'IdempotencyConflictError';
  }
}

interface SubmissionHashes {
  readonly keyHash: string;
  readonly requestHash: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]),
  );
}

function ownershipScope(
  payload: SubmitSightingPayload,
  observer: ObserverPrincipal | null,
): string {
  return observer === null
    ? `anonymous:${payload.observerEmail.trim().toLowerCase()}`
    : `observer:${observer.id}`;
}

export function buildSubmissionHashes(
  payload: SubmitSightingPayload,
  observer: ObserverPrincipal | null,
): SubmissionHashes {
  const scope = ownershipScope(payload, observer);
  return Object.freeze({
    keyHash: sha256(payload.clientSubmissionId),
    requestHash: sha256(JSON.stringify(canonicalValue({ payload, scope }))),
  });
}

export function isPrismaReplayRace(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error.code === 'P2002' || error.code === 'P2034');
}
