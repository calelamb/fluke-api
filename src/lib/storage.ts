// Storage abstraction. Photo bytes go through a backend interface so we can
// run local-disk in development/test and private S3-compatible storage
// in production by changing STORAGE_BACKEND, without touching call sites.
//
// See docs/v1-plan.md § M-V1-1 for the rationale (path c).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '../env.js';
import { S3StorageBackend as S3BackendConstructor } from './s3-storage.js';

export interface StoredObject {
  /** Backend-specific identifier; for local disk, this is the relative path. */
  key: string;
  /** Bytes written. */
  size: number;
}

export interface StorageBackend {
  /**
   * Persist a buffer or stream and return a stable private key and byte count.
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

  /** Resolve a private key to a short-lived URL when supported. */
  signedReadUrl?(key: string): Promise<string>;
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
    const safePrefix = sanitizeStoragePrefix(prefix);
    const safeFilename = sanitizeStorageFilename(filename);
    const targetDir = path.join(this.rootDir, safePrefix);
    await mkdir(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, safeFilename);
    const buffer = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    await writeFile(targetPath, buffer);

    const key = `${safePrefix}/${safeFilename}`;
    return {
      key,
      size: buffer.byteLength,
    };
  }

  async remove(key: string): Promise<void> {
    const target = path.join(this.rootDir, sanitizeStorageKey(key));
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
    return `${this.apiOrigin}${this.urlPrefix}/${sanitizeStorageKey(key)}`;
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
export function sanitizeStoragePrefix(value: string): string {
  if (value.length === 0) throw new Error('Invalid storage segment: empty prefix');
  if (value.startsWith('/')) throw new Error('Invalid storage segment');
  if (value.includes('..')) throw new Error('Invalid storage segment');

  const segments = value.split('/').filter(Boolean);
  if (segments.length === 0) throw new Error('Invalid storage segment');

  for (const segment of segments) {
    if (segment === '..' || segment.startsWith('.')) {
      throw new Error('Invalid storage segment');
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(segment)) {
      throw new Error('Invalid storage segment');
    }
  }
  return segments.join('/');
}

/**
 * Sanitize a storage filename. Must be a single segment — no `/`, no `..`,
 * no leading dot. Throws on anything unsafe.
 */
export function sanitizeStorageFilename(value: string): string {
  if (value.length === 0) throw new Error('Invalid storage segment: empty filename');
  if (value.includes('/')) throw new Error('Invalid storage segment');
  if (value.includes('..')) throw new Error('Invalid storage segment');
  if (value.startsWith('.')) throw new Error('Invalid storage segment');
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error('Invalid storage segment');
  }
  return value;
}

export function sanitizeStorageKey(value: string): string {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 1_024) {
    throw new Error('Invalid storage key');
  }
  const segments = value.split('/');
  if (segments.length < 2) throw new Error('Invalid storage key');
  const filename = sanitizeStorageFilename(segments.at(-1) ?? '');
  const prefix = sanitizeStoragePrefix(segments.slice(0, -1).join('/'));
  return `${prefix}/${filename}`;
}

export function relatedSightingPhotoKeys(largeKey: string): readonly string[] {
  const safeKey = sanitizeStorageKey(largeKey);
  if (!safeKey.endsWith('-1024.webp')) return Object.freeze([safeKey]);
  const stem = safeKey.slice(0, -'-1024.webp'.length);
  return Object.freeze([safeKey, `${stem}-256.webp`]);
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

interface LocalStorageFactoryConfig {
  readonly apiOrigin: string;
  readonly backend: 'local';
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly rootDir: string;
}

interface S3StorageFactoryConfig {
  readonly backend: 's3';
  readonly s3: import('./s3-storage.js').S3StorageConfig;
}

export type StorageFactoryConfig = LocalStorageFactoryConfig | S3StorageFactoryConfig;

export function createStorageBackend(config: StorageFactoryConfig): StorageBackend {
  if (config.backend === 'local') {
    if (config.nodeEnv === 'production') {
      throw new Error('Production cannot use local object storage');
    }
    return new LocalDiskBackend({
      apiOrigin: config.apiOrigin,
      rootDir: config.rootDir,
    });
  }
  // Dynamic import is not usable in this synchronous factory, so construction
  // is delegated to the cached async-free module binding below.
  return new S3BackendConstructor(config.s3);
}

export function getStorageBackend(): StorageBackend {
  if (cached) return cached;
  if (env.STORAGE_BACKEND === 's3') {
    cached = createStorageBackend({
      backend: 's3',
      s3: {
        accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID!,
        bucket: env.OBJECT_STORAGE_BUCKET!,
        endpoint: env.OBJECT_STORAGE_ENDPOINT!,
        forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE!,
        region: env.OBJECT_STORAGE_REGION!,
        secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
      },
    });
  } else {
    cached = createStorageBackend({
      apiOrigin: env.API_PUBLIC_ORIGIN,
      backend: 'local',
      nodeEnv: env.NODE_ENV,
      rootDir: resolveUploadsDir(),
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
