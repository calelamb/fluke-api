import type { ScheduledJobName } from './job-catalog.js';

const PUBLIC_READ_ORIGIN = 'https://fluke-pnw.vercel.app';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PODS = Object.freeze(['J', 'K', 'L', 'BIGGS']);
const HORIZONS = Object.freeze(['24h', '7d', '30d']);

type Fetch = (request: Request) => Promise<Response>;

interface WarmDependencies {
  readonly fetch: Fetch;
  readonly origin: string;
  readonly timeoutMs?: number;
}

export interface WarmResult {
  readonly attempted: number;
  readonly warmed: number;
}

export function publicReadTargets(name: ScheduledJobName | string): readonly string[] {
  if (name === 'acartia' || name === 'gbif') {
    return Object.freeze(['/api/public/v1/sighting-feed?limit=100']);
  }
  if (name === 'predictions') {
    return Object.freeze(PODS.flatMap((pod) => HORIZONS.map(
      (horizon) => `/api/public/v1/predict?pod=${pod}&horizon=${horizon}`,
    )));
  }
  throw new Error('Unknown warm job');
}

export async function warmPublicReads(
  name: ScheduledJobName,
  dependencies: WarmDependencies,
): Promise<WarmResult> {
  const origin = validateOrigin(dependencies.origin);
  const targets = publicReadTargets(name);
  const timeoutMs = validateTimeout(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let warmed = 0;
  for (let offset = 0; offset < targets.length; offset += 3) {
    const batch = targets.slice(offset, offset + 3);
    const results = await Promise.all(batch.map((path) => warmOne(
      new URL(path, origin), dependencies.fetch, timeoutMs,
    )));
    warmed += results.filter(Boolean).length;
  }
  if (warmed !== targets.length) throw new Error('Public read warm failed');
  return Object.freeze({ attempted: targets.length, warmed });
}

function validateOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.origin !== PUBLIC_READ_ORIGIN || origin.href !== `${PUBLIC_READ_ORIGIN}/`) {
    throw new Error('Invalid public read origin');
  }
  return origin;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_TIMEOUT_MS) {
    throw new Error('Invalid warm timeout');
  }
  return value;
}

async function warmOne(url: URL, fetch: Fetch, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(fetch, new Request(url, {
      method: 'GET', headers: { accept: 'application/json' },
    }), timeoutMs);
    if (response.status === 404) return true;
    if (!response.ok || !isJson(response.headers) || declaredTooLarge(response.headers)) {
      return false;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return false;
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(
  fetch: Fetch,
  request: Request,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const boundedRequest = new Request(request, { signal: controller.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Public read warm timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetch(boundedRequest), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isJson(headers: Headers): boolean {
  return /^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(headers.get('content-type') ?? '');
}

function declaredTooLarge(headers: Headers): boolean {
  const raw = headers.get('content-length');
  if (!raw) return false;
  const value = Number(raw);
  return !Number.isSafeInteger(value) || value < 0 || value > MAX_RESPONSE_BYTES;
}
