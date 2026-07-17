// Storage abstraction. Photo bytes go through a backend interface so we can
// run local-disk in dev today and switch to R2 (or any S3-compatible store)
// in production by changing STORAGE_BACKEND, without touching call sites.
//
// See docs/v1-plan.md § M-V1-1 for the rationale (path c).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '../env.js';

export interface StoredObject {
  /** Backend-specific identifier; for local disk, this is the relative path. */
  key: string;
  /** A URL the browser can hit to fetch the object. */
  url: string;
  /** Bytes written. */
  size: number;
}

export interface StorageBackend {
  /**
   * Persist a buffer or stream and return a stable key + a fetchable URL.
   * The key includes any subdirectory layout the backend wants to impose
   * (e.g. `sightings/abc/large.webp`). Caller decides the prefix.
   */
  put(input: {
    prefix: string;
    filename: string;
    contentType: string;
    body: Buffer | Readable;
  }): Promise<StoredObject>;

  /** Best-effort delete; missing objects do not throw. */
  remove(key: string): Promise<void>;

  /** Resolve a stored key to a URL the browser can fetch. */
  publicUrl(key: string): string;
}

// ---------------------------------------------------------------------------
// LocalDiskBackend
// ---------------------------------------------------------------------------

export interface LocalDiskOptions {
  /** Filesystem root where files are written. */
  rootDir: string;
  /**
   * URL prefix the API serves the rootDir under. Combined with the key to
   * produce a publicUrl. Default '/uploads'.
   */
  urlPrefix?: string;
  /** API origin for absolute URLs (e.g. http://localhost:4000). */
  apiOrigin: string;
}

export class LocalDiskBackend implements StorageBackend {
  private readonly rootDir: string;
  private readonly urlPrefix: string;
  private readonly apiOrigin: string;

  constructor(options: LocalDiskOptions) {
    this.rootDir = options.rootDir;
    this.urlPrefix = options.urlPrefix ?? '/uploads';
    this.apiOrigin = options.apiOrigin.replace(/\/$/, '');
  }

  async put({
    prefix,
    filename,
    body,
  }: {
    prefix: string;
    filename: string;
    contentType: string;
    body: Buffer | Readable;
  }): Promise<StoredObject> {
    const safePrefix = sanitizePrefix(prefix);
    const safeFilename = sanitizeFilename(filename);
    const targetDir = path.join(this.rootDir, safePrefix);
    await mkdir(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, safeFilename);
    const buffer = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    await writeFile(targetPath, buffer);

    const key = `${safePrefix}/${safeFilename}`;
    return {
      key,
      url: this.publicUrl(key),
      size: buffer.byteLength,
    };
  }

  async remove(key: string): Promise<void> {
    const target = path.join(this.rootDir, key);
    try {
      await import('node:fs/promises').then((fs) => fs.unlink(target));
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
  }

  publicUrl(key: string): string {
    return `${this.apiOrigin}${this.urlPrefix}/${key}`;
  }
}

// ---------------------------------------------------------------------------
// R2Backend (stub)
// ---------------------------------------------------------------------------

export interface R2Options {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicHost: string;
}

/**
 * Cloudflare R2 backend stub. Kept as a placeholder so the env validator
 * can route STORAGE_BACKEND=r2 without breaking the API; the actual S3
 * client wiring lands when credentials exist (see docs/v1-plan.md).
 */
export class R2Backend implements StorageBackend {
  constructor(private readonly options: R2Options) {}

  async put(): Promise<StoredObject> {
    throw new Error(
      'R2Backend is a stub. Wire @aws-sdk/client-s3 against options before enabling STORAGE_BACKEND=r2.',
    );
  }

  async remove(): Promise<void> {
    throw new Error('R2Backend is a stub.');
  }

  publicUrl(key: string): string {
    return `${this.options.publicHost.replace(/\/$/, '')}/${key}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a stable filename from the original and a content hash.
 * Format: `<sha256-prefix>-<random>.<ext>` so duplicates stay distinct
 * (we don't dedupe yet; if the same bytes are uploaded for two sightings
 * each gets its own row).
 */
export function buildPhotoFilename(originalName: string, body: Buffer): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
  const random = randomUUID().slice(0, 8);
  const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
  return `${hash}-${random}${ext}`;
}

/**
 * Sanitize a storage prefix that MAY contain `/` separators between segments
 * (e.g. `sightings/abc`). Rejects any path-traversal patterns; throws if the
 * input is unsafe rather than silently mangling it.
 */
function sanitizePrefix(value: string): string {
  if (value.length === 0) throw new Error('Invalid storage segment: empty prefix');
  if (value.startsWith('/')) throw new Error(`Invalid storage segment: ${value}`);
  if (value.includes('..')) throw new Error(`Invalid storage segment: ${value}`);

  const segments = value.split('/').filter(Boolean);
  if (segments.length === 0) throw new Error(`Invalid storage segment: ${value}`);

  for (const segment of segments) {
    if (segment === '..' || segment.startsWith('.')) {
      throw new Error(`Invalid storage segment: ${value}`);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(segment)) {
      throw new Error(`Invalid storage segment: ${value}`);
    }
  }
  return segments.join('/');
}

/**
 * Sanitize a storage filename. Must be a single segment — no `/`, no `..`,
 * no leading dot. Throws on anything unsafe.
 */
function sanitizeFilename(value: string): string {
  if (value.length === 0) throw new Error('Invalid storage segment: empty filename');
  if (value.includes('/')) throw new Error(`Invalid storage segment: ${value}`);
  if (value.includes('..')) throw new Error(`Invalid storage segment: ${value}`);
  if (value.startsWith('.')) throw new Error(`Invalid storage segment: ${value}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid storage segment: ${value}`);
  }
  return value;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Resolve the project's local-disk uploads directory from env.UPLOADS_DIR. */
export function resolveUploadsDir(): string {
  // Resolve relative to the API package root regardless of CWD at boot time.
  // import.meta.url points at apps/api/src/lib/storage.ts when running tsx.
  const here = new URL('.', import.meta.url).pathname;
  return path.resolve(here, '../../', env.UPLOADS_DIR);
}

let cached: StorageBackend | null = null;

export function getStorageBackend(): StorageBackend {
  if (cached) return cached;
  if (env.STORAGE_BACKEND === 'r2') {
    cached = new R2Backend({
      bucket: env.R2_BUCKET!,
      endpoint: env.R2_ENDPOINT!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      publicHost: env.R2_PUBLIC_HOST!,
    });
  } else {
    cached = new LocalDiskBackend({
      rootDir: resolveUploadsDir(),
      apiOrigin: env.API_PUBLIC_ORIGIN,
    });
  }
  return cached;
}

/**
 * Reset the cached backend — only used in tests where env is mutated between
 * cases.
 */
export function _resetStorageBackend(): void {
  cached = null;
}
