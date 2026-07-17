const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 5_000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

type FetchImplementation = typeof fetch;
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export class ProviderRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(code: string, retryable: boolean, retryAfterMs: number | null = null) {
    super('Provider request failed');
    this.name = 'ProviderRequestError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ProviderRequestOptions {
  readonly attemptTimeoutMs: number;
  readonly fetchImpl?: FetchImplementation;
  readonly maxAttempts?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
  readonly sleep?: Sleep;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Provider request aborted');
}

async function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const onElapsed = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(onElapsed, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timeout.unref();
  });
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const parsed = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.round(parsed), MAX_RETRY_AFTER_MS);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new ProviderRequestError('PROVIDER_RESPONSE_TOO_LARGE', false);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ProviderRequestError('PROVIDER_RESPONSE_TOO_LARGE', false);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function fetchAttempt(
  url: string,
  options: Required<Pick<ProviderRequestOptions, 'attemptTimeoutMs' | 'maxResponseBytes'>> & {
    readonly fetchImpl: FetchImplementation;
    readonly parentSignal: AbortSignal;
  },
): Promise<unknown> {
  const timeout = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeout.abort(new ProviderRequestError('PROVIDER_TIMEOUT', true)),
    options.attemptTimeoutMs,
  );
  timeoutHandle.unref();
  const signal = AbortSignal.any([options.parentSignal, timeout.signal]);

  try {
    const response = await options.fetchImpl(url, {
      headers: { Accept: 'application/json' },
      method: 'GET',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderRequestError(
        `PROVIDER_HTTP_${response.status}`,
        RETRYABLE_STATUSES.has(response.status),
        retryAfterMilliseconds(response.headers.get('retry-after')),
      );
    }
    const body = await readBoundedBody(response, options.maxResponseBytes);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new ProviderRequestError('PROVIDER_INVALID_JSON', false);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function fetchJsonWithRetry(
  url: string,
  options: ProviderRequestOptions,
): Promise<unknown> {
  const maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  const attemptTimeoutMs = positiveInteger(options.attemptTimeoutMs, 'attemptTimeoutMs');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const parentSignal = options.signal ?? new AbortController().signal;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (parentSignal.aborted) throw abortReason(parentSignal);
    try {
      return await fetchAttempt(url, {
        attemptTimeoutMs,
        fetchImpl,
        maxResponseBytes,
        parentSignal,
      });
    } catch (error: unknown) {
      if (parentSignal.aborted) throw abortReason(parentSignal);
      const failure = error instanceof ProviderRequestError
        ? error
        : new ProviderRequestError('PROVIDER_NETWORK_ERROR', true);
      if (!failure.retryable || attempt === maxAttempts) throw failure;
      const backoff = 250 * 2 ** (attempt - 1);
      await sleep(failure.retryAfterMs ?? backoff, parentSignal);
    }
  }

  throw new ProviderRequestError('PROVIDER_ATTEMPTS_EXHAUSTED', false);
}
