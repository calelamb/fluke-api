import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const postgresEnabled = process.env.RUN_POSTGRES_INTEGRATION === 'true';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(`${repositoryRoot}${relativePath}`, 'utf8');
}

describe('observer submissions schema', () => {
  it('creates observer ownership and globally unique idempotency keys', () => {
    const schema = readRepositoryFile('prisma/schema.prisma');

    expect(schema).toContain('OBSERVER');
    expect(schema).toContain('observerUserId');
    expect(schema).toContain('model SubmissionIdempotency');
    expect(schema).toContain('keyHash     String   @unique');
  });

  it('uses an additive migration that preserves existing identities and sightings', () => {
    const migration = readRepositoryFile(
      'prisma/migrations/20260717170000_add_observer_submissions/migration.sql',
    );

    expect(migration).toContain(`ALTER TYPE "UserRole" ADD VALUE 'OBSERVER'`);
    expect(migration).toContain('ADD COLUMN     "observer_user_id" TEXT');
    expect(migration).toContain('ON DELETE SET NULL ON UPDATE CASCADE');
    expect(migration).toContain('CREATE UNIQUE INDEX "submission_idempotencies_key_hash_key"');
    expect(migration).not.toMatch(/^\s*(?:DELETE FROM|DROP TABLE|TRUNCATE)\b/mu);
  });
});

describe.runIf(postgresEnabled)('observer submissions against PostgreSQL', () => {
  let prisma: typeof import('../../src/db.js')['prisma'];
  const fixture = Object.freeze({
    idempotencyId: 'it-observer-idempotency',
    keyHash: 'it-observer-key-hash',
    sightingId: 'it-observer-sighting',
    userId: 'it-observer-user',
  });

  beforeAll(async () => {
    ({ prisma } = await import('../../src/db.js'));
    await prisma.submissionIdempotency.deleteMany({ where: { id: fixture.idempotencyId } });
    await prisma.sighting.deleteMany({ where: { id: fixture.sightingId } });
    await prisma.user.deleteMany({ where: { id: fixture.userId } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.submissionIdempotency.deleteMany({ where: { id: fixture.idempotencyId } });
    await prisma.sighting.deleteMany({ where: { id: fixture.sightingId } });
    await prisma.user.deleteMany({ where: { id: fixture.userId } });
    await prisma.$disconnect();
  });

  it('persists observer ownership and enforces global idempotency uniqueness', async () => {
    const user = await prisma.user.create({
      data: { id: fixture.userId, role: 'OBSERVER' },
    });
    const sighting = await prisma.sighting.create({
      data: {
        id: fixture.sightingId,
        latitude: 48.5,
        longitude: -123,
        observedAt: new Date(),
        observerEmail: 'observer-integration@example.invalid',
        observerUserId: user.id,
      },
    });
    await prisma.submissionIdempotency.create({
      data: {
        id: fixture.idempotencyId,
        keyHash: fixture.keyHash,
        requestHash: 'request-hash',
        sightingId: sighting.id,
        userId: user.id,
      },
    });

    await expect(
      prisma.submissionIdempotency.create({
        data: {
          keyHash: fixture.keyHash,
          requestHash: 'another-request-hash',
          sightingId: sighting.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps a sighting when its observer is deleted', async () => {
    await prisma.submissionIdempotency.deleteMany({ where: { id: fixture.idempotencyId } });
    await prisma.user.delete({ where: { id: fixture.userId } });

    await expect(
      prisma.sighting.findUniqueOrThrow({ where: { id: fixture.sightingId } }),
    ).resolves.toMatchObject({ observerUserId: null });
  });
});
