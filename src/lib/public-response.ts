import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';

export interface PublicCachePolicy {
  readonly maxAgeSeconds: number;
  readonly staleWhileRevalidateSeconds: number;
}

export const CATALOG_CACHE_POLICY = Object.freeze({
  maxAgeSeconds: 60,
  staleWhileRevalidateSeconds: 300,
});

export const LIVE_READ_CACHE_POLICY = Object.freeze({
  maxAgeSeconds: 30,
  staleWhileRevalidateSeconds: 60,
});

function requestMatchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const values = Array.isArray(header) ? header : header.split(',');
  return values.some((value) => {
    const candidate = value.trim();
    const normalizedCandidate = candidate.startsWith('W/') ? candidate.slice(2) : candidate;
    const normalizedEtag = etag.startsWith('W/') ? etag.slice(2) : etag;
    return candidate === '*' || normalizedCandidate === normalizedEtag;
  });
}

export function sendPublicResponse<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  schema: ZodType<T>,
  payload: unknown,
  cachePolicy: PublicCachePolicy,
): T | FastifyReply {
  const validated = schema.parse(payload);
  const serialized = JSON.stringify(validated);
  const digest = createHash('sha256').update(serialized).digest('base64url');
  const etag = `W/"${digest}"`;
  reply
    .header(
      'cache-control',
      `public, max-age=${cachePolicy.maxAgeSeconds}, stale-while-revalidate=${cachePolicy.staleWhileRevalidateSeconds}`,
    )
    .header('etag', etag);

  if (requestMatchesEtag(request.headers['if-none-match'], etag)) {
    return reply.code(304).send();
  }
  return validated;
}
