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

const { S3StorageBackend, parseS3StorageConfig } = await import('../lib/s3-storage.js');

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
