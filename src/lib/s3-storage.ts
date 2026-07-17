import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import ipaddr from 'ipaddr.js';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  sanitizeStorageFilename,
  sanitizeStorageKey,
  sanitizeStoragePrefix,
  type StorageBackend,
  type StoredObject,
} from './storage.js';
import { objectStorageEndpointIssue } from './storage-endpoint.js';

const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const SIGNED_READ_SECONDS = 5 * 60;
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export type EndpointResolver = (hostname: string) => Promise<readonly LookupAddress[]>;
export type StorageOperation = 'delete' | 'presign' | 'put';

export class StorageUnavailableError extends Error {
  readonly failureKind = 'object-storage';
  readonly retryable = true;
  readonly statusCode = 503;

  constructor(readonly operation: StorageOperation) {
    super('Private object storage is temporarily unavailable');
    this.name = 'StorageUnavailableError';
  }
}

interface PinnedLookupOptions {
  readonly all?: boolean;
}

type PinnedLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | readonly LookupAddress[],
  family?: number,
) => void;

const s3StorageConfigSchema = z.object({
  accessKeyId: z.string().min(1).max(256),
  bucket: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u),
  endpoint: z.string().url(),
  forcePathStyle: z.boolean(),
  region: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/u),
  secretAccessKey: z.string().min(1).max(1_024),
}).strict().superRefine((value, context) => {
  const issue = objectStorageEndpointIssue(value.endpoint);
  if (issue !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ['endpoint'] });
  }
});

export type S3StorageConfig = Readonly<z.infer<typeof s3StorageConfigSchema>>;

function assertPublicAddresses(addresses: readonly LookupAddress[]): void {
  if (addresses.length === 0) throw new Error('Object storage endpoint DNS returned no addresses');
  for (const { address } of addresses) {
    if (!ipaddr.isValid(address) || ipaddr.process(address).range() !== 'unicast') {
      throw new Error('Object storage endpoint DNS must resolve only to public addresses');
    }
  }
}

async function defaultEndpointResolver(hostname: string): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function assertPublicEndpointResolution(
  endpoint: string,
  resolver: EndpointResolver = defaultEndpointResolver,
): Promise<void> {
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/gu, '');
  assertPublicAddresses(await resolver(hostname));
}

export function createPinnedLookup(
  resolver: EndpointResolver = defaultEndpointResolver,
): (hostname: string, options: PinnedLookupOptions, callback: PinnedLookupCallback) => void {
  return (hostname, options, callback): void => {
    void resolver(hostname).then((addresses) => {
      assertPublicAddresses(addresses);
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }).catch((_error: unknown) => {
      const safeError = new Error('Object storage endpoint DNS validation failed');
      safeError.name = 'StorageEndpointError';
      callback(safeError, '', 0);
    });
  };
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
      requestHandler: new NodeHttpHandler({
        httpsAgent: new Agent({
          keepAlive: true,
          lookup: createPinnedLookup() as LookupFunction,
        }),
      }),
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
    try {
      await this.#client.send(new PutObjectCommand({
        Body: body,
        Bucket: this.#config.bucket,
        ContentLength: body.byteLength,
        ContentType: input.contentType,
        Key: key,
      }));
    } catch {
      throw new StorageUnavailableError('put');
    }
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
      if (!isMissingObject(error)) throw new StorageUnavailableError('delete');
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
    try {
      return await getSignedUrl(this.#client, command, { expiresIn: SIGNED_READ_SECONDS });
    } catch {
      throw new StorageUnavailableError('presign');
    }
  }
}
