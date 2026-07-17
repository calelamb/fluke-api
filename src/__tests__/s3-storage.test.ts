import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }));

const {
  S3StorageBackend,
  StorageUnavailableError,
  assertPublicEndpointResolution,
  createPinnedLookup,
  parseS3StorageConfig,
} = await import('../lib/s3-storage.js');

const CONFIG = Object.freeze({
  accessKeyId: 'access-key-id',
  bucket: 'fluke-private',
  endpoint: 'https://objects.example.com',
  forcePathStyle: true,
  region: 'us-west-2',
  secretAccessKey: 'secret-access-key',
});

function buildStorage(send = vi.fn().mockResolvedValue({})): {
  readonly send: ReturnType<typeof vi.fn>;
  readonly storage: InstanceType<typeof S3StorageBackend>;
} {
  const client = { send } as unknown as S3Client;
  return { send, storage: new S3StorageBackend(CONFIG, client) };
}

describe('S3StorageBackend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a private bounded object with its declared image type', async () => {
    const { send, storage } = buildStorage();
    const result = await storage.put({
      body: Buffer.from('image'),
      contentType: 'image/webp',
      filename: 'large.webp',
      prefix: 'sightings/s-1',
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Body: Buffer.from('image'),
      Bucket: 'fluke-private',
      ContentLength: 5,
      ContentType: 'image/webp',
      Key: 'sightings/s-1/large.webp',
    });
    expect(command.input).not.toHaveProperty('ACL');
    expect(result).toEqual({ key: 'sightings/s-1/large.webp', size: 5 });
  });

  it('creates a five-minute signed GET URL without exposing credentials', async () => {
    getSignedUrl.mockResolvedValue('https://signed.example/read?redacted=true');
    const { storage } = buildStorage();

    await expect(storage.signedReadUrl('sightings/s-1/large.webp')).resolves.toBe(
      'https://signed.example/read?redacted=true',
    );
    const command = getSignedUrl.mock.calls[0]?.[1];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: 'fluke-private', Key: 'sightings/s-1/large.webp' });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), command, { expiresIn: 300 });
  });

  it('deletes a private key and treats a missing key as success', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
      .mockResolvedValueOnce({});
    const { storage } = buildStorage(send);

    await expect(storage.remove('sightings/s-1/missing.webp')).resolves.toBeUndefined();
    await expect(storage.remove('sightings/s-1/photo.webp')).resolves.toBeUndefined();
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it.each([
    ['unsafe prefix', { prefix: '../private', filename: 'photo.webp', contentType: 'image/webp' }],
    ['unsafe filename', { prefix: 'sightings/s-1', filename: '../photo.webp', contentType: 'image/webp' }],
    ['unsupported content type', { prefix: 'sightings/s-1', filename: 'photo.gif', contentType: 'image/gif' }],
  ])('rejects %s before sending', async (_name, input) => {
    const { send, storage } = buildStorage();
    await expect(storage.put({ ...input, body: Buffer.from('x') })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects oversized buffers and streams before sending them', async () => {
    const { send, storage } = buildStorage();
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(storage.put({
      body: oversized,
      contentType: 'image/webp',
      filename: 'photo.webp',
      prefix: 'sightings/s-1',
    })).rejects.toThrow(/size/i);
    await expect(storage.put({
      body: Readable.from([oversized]),
      contentType: 'image/webp',
      filename: 'photo.webp',
      prefix: 'sightings/s-1',
    })).rejects.toThrow(/size/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects object keys longer than the S3 key boundary before sending', async () => {
    const { send, storage } = buildStorage();
    await expect(storage.put({
      body: Buffer.from('x'),
      contentType: 'image/webp',
      filename: 'photo.webp',
      prefix: `sightings/${'a'.repeat(1_020)}`,
    })).rejects.toThrow(/key/i);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['put', 'delete'] as const)('redacts raw SDK %s failures as retryable 503 errors', async (operation) => {
    const raw = Object.assign(new Error(
      'AWS failure Authorization=secret-access-key sightings/s-1/private.webp',
    ), {
      $metadata: { httpHeaders: { authorization: 'secret-access-key' }, httpStatusCode: 500 },
    });
    const { storage } = buildStorage(vi.fn().mockRejectedValue(raw));
    const promise = operation === 'put'
      ? storage.put({
        body: Buffer.from('image'),
        contentType: 'image/webp',
        filename: 'private.webp',
        prefix: 'sightings/s-1',
      })
      : storage.remove('sightings/s-1/private.webp');

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect(error).toMatchObject({
      failureKind: 'object-storage',
      operation,
      retryable: true,
      statusCode: 503,
    });
    const serialized = JSON.stringify(error) + String((error as Error).stack);
    expect(serialized).not.toContain('secret-access-key');
    expect(serialized).not.toContain('private.webp');
    expect(serialized).not.toContain('Authorization');
  });

  it('redacts raw presigner failures as retryable 503 errors', async () => {
    getSignedUrl.mockRejectedValue(new Error('secret-access-key private.webp'));
    const { storage } = buildStorage();
    const error = await storage.signedReadUrl('sightings/s-1/private.webp')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect(error).toMatchObject({ operation: 'presign', statusCode: 503 });
    expect(String((error as Error).stack)).not.toContain('secret-access-key');
    expect(String((error as Error).stack)).not.toContain('private.webp');
  });
});

describe('parseS3StorageConfig', () => {
  it('accepts an HTTPS public endpoint without a path', () => {
    expect(parseS3StorageConfig(CONFIG)).toEqual(CONFIG);
  });

  it.each([
    ['plain HTTP', 'http://objects.example.com'],
    ['credentials', 'https://user:pass@objects.example.com'],
    ['private IPv4', 'https://127.0.0.1'],
    ['private IPv6', 'https://[fd00::1]'],
    ['local hostname', 'https://minio.local'],
    ['path', 'https://objects.example.com/bucket'],
  ])('rejects an SSRF-unsafe %s endpoint', (_name, endpoint) => {
    expect(() => parseS3StorageConfig({ ...CONFIG, endpoint })).toThrow(/endpoint/i);
  });

  it('rejects malformed buckets, regions, and credentials', () => {
    expect(() => parseS3StorageConfig({ ...CONFIG, bucket: '..' })).toThrow(/bucket/i);
    expect(() => parseS3StorageConfig({ ...CONFIG, region: 'bad region' })).toThrow(/region/i);
    expect(() => parseS3StorageConfig({ ...CONFIG, secretAccessKey: '' })).toThrow(/secretAccessKey/i);
  });
});

describe('S3 endpoint DNS pinning', () => {
  const publicAddress = Object.freeze({ address: '8.8.8.8', family: 4 as const });

  it('pins each connection to a resolver-vetted public address', async () => {
    const resolver = vi.fn().mockResolvedValue([publicAddress]);
    const lookup = createPinnedLookup(resolver);
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup('objects.example.com', {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });
    expect(result).toEqual(publicAddress);
    expect(resolver).toHaveBeenCalledWith('objects.example.com');
  });

  it.each([
    ['IPv4 loopback', '127.0.0.1'],
    ['IPv4 private', '10.0.0.2'],
    ['IPv4 link-local', '169.254.20.1'],
    ['IPv4 multicast', '224.0.0.1'],
    ['IPv4 reserved', '240.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv6 private', 'fd00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 multicast', 'ff02::1'],
  ])('rejects a hostname resolving to %s', async (_name, address) => {
    const family = address.includes(':') ? 6 as const : 4 as const;
    await expect(assertPublicEndpointResolution(
      'https://objects.example.com',
      vi.fn().mockResolvedValue([{ address, family }]),
    )).rejects.toThrow(/public/i);
  });

  it('rejects mixed public and private DNS answers', async () => {
    await expect(assertPublicEndpointResolution(
      'https://objects.example.com',
      vi.fn().mockResolvedValue([
        publicAddress,
        { address: '192.168.1.10', family: 4 },
      ]),
    )).rejects.toThrow(/public/i);
  });

  it('revalidates every connection so a rebinding answer is rejected', async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(assertPublicEndpointResolution(CONFIG.endpoint, resolver)).resolves.toBeUndefined();
    await expect(assertPublicEndpointResolution(CONFIG.endpoint, resolver)).rejects.toThrow(/public/i);
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});
