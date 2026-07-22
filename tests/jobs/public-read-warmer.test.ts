import { describe, expect, it, vi } from 'vitest';
import { publicReadTargets, warmPublicReads } from '../../src/jobs/public-read-warmer.js';

describe('post-job public read warming', () => {
  it('maps ingestion jobs only to the first real feed page', () => {
    expect(publicReadTargets('acartia')).toEqual(['/api/public/v1/sighting-feed?limit=100']);
    expect(publicReadTargets('gbif')).toEqual(['/api/public/v1/sighting-feed?limit=100']);
  });

  it('maps predictions to the bounded canonical pod and horizon reads', () => {
    const targets = publicReadTargets('predictions');
    expect(targets).toHaveLength(12);
    expect(targets).toContain('/api/public/v1/predict?pod=J&horizon=24h');
    expect(targets).toContain('/api/public/v1/predict?pod=BIGGS&horizon=30d');
  });

  it('rejects unknown jobs and non-production origins before fetch', async () => {
    expect(() => publicReadTargets('unknown')).toThrow('Unknown warm job');
    const fetch = vi.fn();
    await expect(warmPublicReads('acartia', {
      fetch,
      origin: 'https://attacker.example',
    })).rejects.toThrow('Invalid public read origin');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses anonymous GETs and validates successful JSON responses', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('GET');
      expect(request.headers.has('authorization')).toBe(false);
      expect(request.headers.has('cookie')).toBe(false);
      return new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } });
    });
    const result = await warmPublicReads('acartia', {
      fetch,
      origin: 'https://fluke-pnw.vercel.app',
    });

    expect(result).toEqual({ attempted: 1, warmed: 1 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('reports a bounded failure for invalid content or a hung request', async () => {
    await expect(warmPublicReads('acartia', {
      fetch: async () => new Response('<html>oops</html>', {
        headers: { 'content-type': 'text/html' },
      }),
      origin: 'https://fluke-pnw.vercel.app',
    })).rejects.toThrow('Public read warm failed');

    await expect(warmPublicReads('acartia', {
      fetch: async () => new Promise<Response>(() => {}),
      origin: 'https://fluke-pnw.vercel.app',
      timeoutMs: 5,
    })).rejects.toThrow('Public read warm failed');
  });
});
