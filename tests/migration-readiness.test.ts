import { describe, expect, it, vi } from 'vitest';
import {
  assertRequiredMigration,
  REQUIRED_MIGRATION,
  type MigrationQueryClient,
} from '../src/ops/migration-readiness.js';

function clientWithStatus(
  requiredApplied: boolean,
  unresolvedCount: bigint,
): MigrationQueryClient {
  return {
    $queryRaw: vi.fn(async () => [{ requiredApplied, unresolvedCount }]),
  };
}

describe('assertRequiredMigration', () => {
  it('requires the observer migration as the readiness marker', () => {
    expect(REQUIRED_MIGRATION).toBe('20260717183000_bound_sighting_photo_order');
  });

  it('accepts a database with the required migration applied', async () => {
    await expect(assertRequiredMigration(clientWithStatus(true, 0n))).resolves.toBeUndefined();
  });

  it('rejects a database that is missing the image-required migration', async () => {
    await expect(assertRequiredMigration(clientWithStatus(false, 0n))).rejects.toThrow(
      `Required migration ${REQUIRED_MIGRATION} is not applied`,
    );
  });

  it('rejects a database with an unresolved failed migration', async () => {
    await expect(assertRequiredMigration(clientWithStatus(true, 1n))).rejects.toThrow(
      'Database has 1 unresolved migration',
    );
  });

  it('does not require the image migration to be the newest database migration', async () => {
    await expect(assertRequiredMigration(clientWithStatus(true, 0n))).resolves.toBeUndefined();
  });
});
