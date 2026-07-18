import type { StorageBackend, StoredObject } from '../lib/storage.js';

const CLEANUP_ATTEMPTS = 3;

export interface PhotoCleanupFailure {
  readonly attempts: number;
  readonly failedObjects: number;
  readonly failureKind: 'storage-cleanup';
  readonly operation: 'photo-compensation';
}

interface StoredPhotoPair {
  readonly large: StoredObject;
  readonly thumbnail: StoredObject;
}

async function removeWithRetries(storage: StorageBackend, key: string): Promise<boolean> {
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await storage.remove(key);
      return true;
    } catch {
      // Retry with a strict fixed bound; caller records only a sanitized count.
    }
  }
  return false;
}

export async function cleanupPhotoObjects(
  storage: StorageBackend,
  keys: readonly string[],
  recordCleanupFailure: (failure: PhotoCleanupFailure) => void,
): Promise<void> {
  const outcomes = await Promise.all(keys.map((key) => removeWithRetries(storage, key)));
  const failedObjects = outcomes.filter((removed) => !removed).length;
  if (failedObjects > 0) {
    recordCleanupFailure(Object.freeze({
      attempts: CLEANUP_ATTEMPTS,
      failedObjects,
      failureKind: 'storage-cleanup',
      operation: 'photo-compensation',
    }));
  }
}

export async function storePhotoPair(input: {
  readonly createPhoto: (pair: StoredPhotoPair) => Promise<unknown>;
  readonly large: Parameters<StorageBackend['put']>[0];
  readonly recordCleanupFailure?: (failure: PhotoCleanupFailure) => void;
  readonly storage: StorageBackend;
  readonly thumbnail: Parameters<StorageBackend['put']>[0];
}): Promise<StoredPhotoPair> {
  const recordCleanupFailure = input.recordCleanupFailure ?? (() => undefined);
  const large = await input.storage.put(input.large);
  let thumbnail: StoredObject;
  try {
    thumbnail = await input.storage.put(input.thumbnail);
  } catch (error: unknown) {
    await cleanupPhotoObjects(input.storage, [large.key], recordCleanupFailure);
    throw error;
  }

  const pair = Object.freeze({ large, thumbnail });
  try {
    await input.createPhoto(pair);
    return pair;
  } catch (error: unknown) {
    await cleanupPhotoObjects(input.storage, [large.key, thumbnail.key], recordCleanupFailure);
    throw error;
  }
}
