import { describe, expect, it, vi } from 'vitest';
import {
  fetchJsonWithRetry,
  ProviderRequestError,
} from '../../src/jobs/provider-client.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('fetchJsonWithRetry', () => {
  it('retries retryable status codes up to the bounded third attempt', async () => {
    const fetchImpl = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const sleep = vi.fn(async () => undefined);

    await expect(fetchJsonWithRetry('https://provider.example/data', {
      attemptTimeoutMs: 1_000,
      fetchImpl,
      sleep,
    })).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250, expect.any(AbortSignal));
    expect(sleep).toHaveBeenNthCalledWith(2, 500, expect.any(AbortSignal));
  });

  it('does not retry a non-retryable client response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 400));

    await expect(fetchJsonWithRetry('https://provider.example/data', {
      attemptTimeoutMs: 1_000,
      fetchImpl,
    })).rejects.toMatchObject({ code: 'PROVIDER_HTTP_400' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caps Retry-After before another attempt', async () => {
    const throttled = jsonResponse({}, 429);
    throttled.headers.set('retry-after', '60');
    const fetchImpl = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const sleep = vi.fn(async () => undefined);

    await fetchJsonWithRetry('https://provider.example/data', {
      attemptTimeoutMs: 1_000,
      fetchImpl,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
  });

  it('rejects an oversized response without retrying it', async () => {
    const fetchImpl = vi.fn(async () => new Response('123456', {
      headers: { 'content-length': '6' },
    }));

    await expect(fetchJsonWithRetry('https://provider.example/data', {
      attemptTimeoutMs: 1_000,
      fetchImpl,
      maxResponseBytes: 5,
    })).rejects.toBeInstanceOf(ProviderRequestError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('stops immediately when the parent signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop job'));
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));

    await expect(fetchJsonWithRetry('https://provider.example/data', {
      attemptTimeoutMs: 1_000,
      fetchImpl,
      signal: controller.signal,
    })).rejects.toThrow('stop job');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
