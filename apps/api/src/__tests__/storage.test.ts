import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskBackend, buildPhotoFilename } from '../lib/storage.js';

describe('LocalDiskBackend', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'fluke-storage-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('writes a buffer to disk under the prefix and returns a fetchable URL', async () => {
    const backend = new LocalDiskBackend({
      rootDir,
      apiOrigin: 'http://localhost:4000',
    });

    const result = await backend.put({
      prefix: 'sightings/abc',
      filename: 'photo.webp',
      contentType: 'image/webp',
      body: Buffer.from('hello-bytes'),
    });

    expect(result.key).toBe('sightings/abc/photo.webp');
    expect(result.url).toBe('http://localhost:4000/uploads/sightings/abc/photo.webp');
    expect(result.size).toBe(11);

    const written = await readFile(path.join(rootDir, result.key));
    expect(written.toString()).toBe('hello-bytes');
  });

  it('rejects path-traversal attempts in prefix or filename', async () => {
    const backend = new LocalDiskBackend({ rootDir, apiOrigin: 'http://x' });
    await expect(
      backend.put({
        prefix: '../escape',
        filename: 'x.webp',
        contentType: 'image/webp',
        body: Buffer.from('x'),
      }),
    ).rejects.toThrow(/Invalid storage segment/);
    await expect(
      backend.put({
        prefix: 'sightings/abc',
        filename: '/etc/passwd',
        contentType: 'image/webp',
        body: Buffer.from('x'),
      }),
    ).rejects.toThrow(/Invalid storage segment/);
  });

  it('remove() is idempotent for missing keys', async () => {
    const backend = new LocalDiskBackend({ rootDir, apiOrigin: 'http://x' });
    await expect(backend.remove('does/not/exist.webp')).resolves.toBeUndefined();
  });

  it('publicUrl is stable for a given key', () => {
    const backend = new LocalDiskBackend({
      rootDir,
      apiOrigin: 'https://api.example.com/',
    });
    expect(backend.publicUrl('sightings/abc/photo.webp')).toBe(
      'https://api.example.com/uploads/sightings/abc/photo.webp',
    );
  });
});

describe('buildPhotoFilename', () => {
  it('keeps a recognised extension and prefixes with a content-hash slice', () => {
    const buf = Buffer.from('test-bytes');
    const name = buildPhotoFilename('IMG_0042.JPG', buf);
    expect(name).toMatch(/^[a-f0-9]{12}-[a-f0-9]{8}\.jpg$/);
  });

  it('falls back to .bin for unknown extensions', () => {
    const buf = Buffer.from('test-bytes');
    const name = buildPhotoFilename('weirdfile', buf);
    expect(name).toMatch(/\.bin$/);
  });

  it('produces distinct names for the same content (uuid component)', () => {
    const buf = Buffer.from('same-bytes');
    const a = buildPhotoFilename('a.jpg', buf);
    const b = buildPhotoFilename('a.jpg', buf);
    expect(a).not.toBe(b);
    // hash prefix is identical for identical content
    expect(a.split('-')[0]).toBe(b.split('-')[0]);
  });
});
