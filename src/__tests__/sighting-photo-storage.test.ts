import { describe, expect, it, vi } from 'vitest';
import type { StorageBackend } from '../lib/storage.js';

const { storePhotoPair } = await import('../services/sighting-photo-storage.js');

const large = Object.freeze({
  body: Buffer.from('large'),
  contentType: 'image/webp',
  filename: 'photo-1024.webp',
  prefix: 'sightings/s1',
});
const thumbnail = Object.freeze({
  body: Buffer.from('thumbnail'),
  contentType: 'image/webp',
  filename: 'photo-256.webp',
  prefix: 'sightings/s1',
});

function storageWith(
  put: StorageBackend['put'],
  remove: StorageBackend['remove'],
): StorageBackend {
  return { publicUrl: vi.fn(), put, remove };
}

describe('storePhotoPair cleanup', () => {
  it('preserves the primary failure and records only sanitized bounded cleanup diagnostics', async () => {
    const primary = new Error('primary upload failure');
    const put = vi.fn()
      .mockResolvedValueOnce({ key: 'sightings/s1/private-1024.webp', size: 5 })
      .mockRejectedValueOnce(primary);
    const remove = vi.fn().mockRejectedValue(
      new Error('Authorization=credential sightings/s1/private-1024.webp'),
    );
    const recordCleanupFailure = vi.fn();

    const caught = await storePhotoPair({
      createPhoto: vi.fn(),
      large,
      recordCleanupFailure,
      storage: storageWith(put, remove),
      thumbnail,
    }).catch((error: unknown) => error);

    expect(caught).toBe(primary);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(recordCleanupFailure).toHaveBeenCalledWith({
      attempts: 3,
      failedObjects: 1,
      failureKind: 'storage-cleanup',
      operation: 'photo-compensation',
    });
    const serialized = JSON.stringify(recordCleanupFailure.mock.calls);
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('private-1024.webp');
  });

  it('retries transient cleanup without reporting a terminal failure', async () => {
    const primary = new Error('database failure');
    const put = vi.fn()
      .mockResolvedValueOnce({ key: 'sightings/s1/private-1024.webp', size: 5 })
      .mockResolvedValueOnce({ key: 'sightings/s1/private-256.webp', size: 3 });
    const remove = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(undefined);
    const recordCleanupFailure = vi.fn();

    const caught = await storePhotoPair({
      createPhoto: vi.fn().mockRejectedValue(primary),
      large,
      recordCleanupFailure,
      storage: storageWith(put, remove),
      thumbnail,
    }).catch((error: unknown) => error);

    expect(caught).toBe(primary);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(recordCleanupFailure).not.toHaveBeenCalled();
  });
});
