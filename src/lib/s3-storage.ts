import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import ipaddr from 'ipaddr.js';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  sanitizeStorageFilename,
  sanitizeStorageKey,
  sanitizeStoragePrefix,
  type StorageBackend,
  type StoredObject,
} from './storage.js';

const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const SIGNED_READ_SECONDS = 5 * 60;
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BLOCKED_IP_RANGES = new Set([
  'broadcast',
  'carrierGradeNat',
  'linkLocal',
  'loopback',
  'private',
  'reserved',
  'uniqueLocal',
  'unspecified',
]);

const s3StorageConfigSchema = z.object({
  accessKeyId: z.string().min(1).max(256),
  bucket: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u),
  endpoint: z.string().url(),
  forcePathStyle: z.boolean(),
  region: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/u),
  secretAccessKey: z.string().min(1).max(1_024),
}).strict().superRefine((value, context) => {
  const issue = endpointIssue(value.endpoint);
  if (issue !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ['endpoint'] });
  }
});

export type S3StorageConfig = Readonly<z.infer<typeof s3StorageConfigSchema>>;

function endpointIssue(endpoint: string): string | null {
  const parsed = new URL(endpoint);
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (parsed.protocol !== 'https:') return 'endpoint must use HTTPS';
  if (parsed.username || parsed.password) return 'endpoint must not contain credentials';
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return 'endpoint must not contain a path, query, or fragment';
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return 'endpoint must not use a local hostname';
  }
  if (ipaddr.isValid(hostname) && BLOCKED_IP_RANGES.has(ipaddr.process(hostname).range())) {
    return 'endpoint must not use a private, local, or reserved address';
  }
  return null;
}

export function parseS3StorageConfig(input: unknown): S3StorageConfig {
  return Object.freeze(s3StorageConfigSchema.parse(input));
}

async function boundedBody(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (body.byteLength === 0 || body.byteLength > MAX_OBJECT_BYTES) {
      throw new Error('Object size is outside the permitted range');
    }
    return body;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_OBJECT_BYTES) {
      body.destroy();
      throw new Error('Object size is outside the permitted range');
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new Error('Object size is outside the permitted range');
  return Buffer.concat(chunks, size);
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly name?: unknown; readonly $metadata?: { readonly httpStatusCode?: unknown } };
  return candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404;
}

export class S3StorageBackend implements StorageBackend {
  readonly #config: S3StorageConfig;
  readonly #client: S3Client;

  constructor(config: S3StorageConfig, client?: S3Client) {
    this.#config = parseS3StorageConfig(config);
    this.#client = client ?? new S3Client({
      credentials: {
        accessKeyId: this.#config.accessKeyId,
        secretAccessKey: this.#config.secretAccessKey,
      },
      endpoint: this.#config.endpoint,
      forcePathStyle: this.#config.forcePathStyle,
      region: this.#config.region,
    });
  }

  async put(input: {
    readonly body: Buffer | Readable;
    readonly contentType: string;
    readonly filename: string;
    readonly prefix: string;
  }): Promise<StoredObject> {
    const prefix = sanitizeStoragePrefix(input.prefix);
    const filename = sanitizeStorageFilename(input.filename);
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
      throw new Error('Unsupported object content type');
    }
    const body = await boundedBody(input.body);
    const key = sanitizeStorageKey(`${prefix}/${filename}`);
    await this.#client.send(new PutObjectCommand({
      Body: body,
      Bucket: this.#config.bucket,
      ContentLength: body.byteLength,
      ContentType: input.contentType,
      Key: key,
    }));
    return Object.freeze({ key, size: body.byteLength });
  }

  async remove(key: string): Promise<void> {
    const safeKey = sanitizeStorageKey(key);
    try {
      await this.#client.send(new DeleteObjectCommand({
        Bucket: this.#config.bucket,
        Key: safeKey,
      }));
    } catch (error: unknown) {
      if (!isMissingObject(error)) throw error;
    }
  }

  publicUrl(_key: string): string {
    throw new Error('Private object storage does not expose public URLs');
  }

  async signedReadUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.#config.bucket,
      Key: sanitizeStorageKey(key),
    });
    return getSignedUrl(this.#client, command, { expiresIn: SIGNED_READ_SECONDS });
  }
}
