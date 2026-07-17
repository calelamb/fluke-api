import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const postgresEnabled = process.env.RUN_POSTGRES_INTEGRATION === 'true';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(`${repositoryRoot}${relativePath}`, 'utf8');
}

function deployMigrations(schemaPath: string, databaseUrl: string): void {
  const migrationUrl = new URL(databaseUrl);
  migrationUrl.searchParams.delete('options');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DATABASE_URL: migrationUrl.toString(),
      DIRECT_URL: migrationUrl.toString(),
    },
    stdio: 'pipe',
  });
}

function copyMigrationsThrough(destination: string, latestMigration: string): void {
  const source = join(repositoryRoot, 'prisma/migrations');
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, 'migration_lock.toml'), join(destination, 'migration_lock.toml'));
  for (const migration of readdirSync(source).filter((name) => name <= latestMigration)) {
    cpSync(join(source, migration), join(destination, migration), { recursive: true });
  }
}

function prepareStagedMigrationDirectory(temporaryRoot: string): {
  readonly migrationsDirectory: string;
  readonly schemaPath: string;
} {
  const prismaDirectory = join(temporaryRoot, 'prisma');
  const migrationsDirectory = join(prismaDirectory, 'migrations');
  const schemaPath = join(prismaDirectory, 'schema.prisma');
  copyMigrationsThrough(migrationsDirectory, '20260716220000_add_job_operations');
  writeFileSync(
    schemaPath,
    [
      'datasource db {',
      '  provider  = "postgresql"',
      '  url       = env("DATABASE_URL")',
      '  directUrl = env("DIRECT_URL")',
      '}',
      '',
    ].join('\n'),
  );
  return Object.freeze({ migrationsDirectory, schemaPath });
}

async function seedLegacyRows(databaseUrl: string): Promise<void> {
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await client.$executeRawUnsafe(
      `INSERT INTO "users" ("id", "email", "password_hash", "role")
       VALUES ($1, $2, $3, 'ADMIN'), ($4, $5, $6, 'MODERATOR')`,
      'legacy-admin',
      'legacy-admin@example.invalid',
      'known-admin-hash',
      'legacy-moderator',
      'legacy-moderator@example.invalid',
      'known-moderator-hash',
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "sightings"
        ("id", "observed_at", "latitude", "longitude", "location_name",
         "behavior_notes", "observer_name", "observer_email", "status", "moderated_by")
       VALUES ($1, TIMESTAMP '2026-07-01 12:00:00', $2, $3, $4, $5, $6, $7,
               'APPROVED', $8)`,
      'legacy-sighting', 48.5, -123.25,
      'Salish Sea legacy location', 'Known legacy behavior', 'Known legacy observer',
      'legacy-observer@example.invalid', 'legacy-moderator',
    );
  } finally {
    await client.$disconnect();
  }
}

interface LegacyUserRow {
  readonly appleSub: string | null;
  readonly email: string;
  readonly id: string;
  readonly passwordHash: string;
  readonly role: string;
  readonly sessionVersion: number;
}

interface LegacySightingRow {
  readonly behaviorNotes: string;
  readonly id: string;
  readonly latitude: string;
  readonly locationName: string;
  readonly longitude: string;
  readonly moderatedBy: string;
  readonly observedAt: string;
  readonly observerEmail: string;
  readonly observerName: string;
  readonly observerUserId: string | null;
  readonly status: string;
}

async function readLegacyRows(databaseUrl: string): Promise<{
  readonly sighting: LegacySightingRow | undefined;
  readonly users: readonly LegacyUserRow[];
}> {
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const users = await client.$queryRawUnsafe<LegacyUserRow[]>(
      `SELECT "id", "email", "password_hash" AS "passwordHash", role::text,
              "apple_sub" AS "appleSub", "session_version" AS "sessionVersion"
       FROM "users" ORDER BY "id"`,
    );
    const [sighting] = await client.$queryRawUnsafe<LegacySightingRow[]>(
      `SELECT "id", to_char("observed_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "observedAt",
              "latitude"::text,
              "longitude"::text, "location_name" AS "locationName",
              "behavior_notes" AS "behaviorNotes", "observer_email" AS "observerEmail",
              "observer_name" AS "observerName", status::text,
              "moderated_by" AS "moderatedBy", "observer_user_id" AS "observerUserId"
       FROM "sightings" WHERE "id" = 'legacy-sighting'`,
    );
    return Object.freeze({ sighting, users });
  } finally {
    await client.$disconnect();
  }
}

describe('observer submissions schema', () => {
  it('constrains each sighting to five uniquely ordered photo slots', () => {
    const schema = readRepositoryFile('prisma/schema.prisma');
    const migration = readRepositoryFile(
      'prisma/migrations/20260717183000_bound_sighting_photo_order/migration.sql',
    );

    expect(schema).toContain('@@unique([sightingId, orderIndex]');
    expect(migration).toContain('CHECK ("order_index" BETWEEN 0 AND 4)');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "sighting_photos_sighting_id_order_index_key"',
    );
    expect(migration).not.toMatch(/^\s*(?:DELETE FROM|DROP TABLE|TRUNCATE)\b/mu);
  });

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

  it('returns one durable sighting across concurrent response-loss replays', async () => {
    const clientSubmissionId = '9c543e0e-1417-4fdc-9c4d-9727cbb06bd4';
    const observerEmail = `replay-${process.pid}@example.invalid`;
    const { buildApp } = await import('../../src/app.js');
    const app = await buildApp({
      features: Object.freeze({ accounts: false, identification: false, submissions: true }),
      silent: true,
    });
    await app.ready();
    try {
      const payload = {
        clientSubmissionId,
        latitude: 48.5,
        longitude: -123,
        observedAt: '2026-07-17T12:00:00.000Z',
        observerEmail,
      };
      const responses = await Promise.all([0, 1].map((attempt) => app.inject({
        headers: { 'idempotency-key': clientSubmissionId },
        method: 'POST',
        payload,
        remoteAddress: `127.0.1.${attempt + 1}`,
        url: '/api/v1/sightings',
      })));

      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 201]);
      const ids = responses.map((response) => response.json<{ id: string }>().id);
      expect(new Set(ids).size).toBe(1);
      await expect(prisma.sighting.count({ where: { observerEmail } })).resolves.toBe(1);

      const changedOwner = await app.inject({
        headers: { 'idempotency-key': clientSubmissionId },
        method: 'POST',
        payload: { ...payload, observerEmail: `changed-${observerEmail}` },
        remoteAddress: '127.0.1.3',
        url: '/api/v1/sightings',
      });
      expect(changedOwner.statusCode).toBe(409);
    } finally {
      await prisma.sighting.deleteMany({ where: { observerEmail } });
      await app.close();
    }
  });

  it('keeps a sighting when its observer is deleted', async () => {
    await prisma.submissionIdempotency.deleteMany({ where: { id: fixture.idempotencyId } });
    await prisma.user.delete({ where: { id: fixture.userId } });

    await expect(
      prisma.sighting.findUniqueOrThrow({ where: { id: fixture.sightingId } }),
    ).resolves.toMatchObject({ observerUserId: null });
  });

  it('admits only one concurrent fifth photo with a unique bounded order', async () => {
    const sightingId = `it-photo-concurrency-${process.pid}`;
    await prisma.sighting.deleteMany({ where: { id: sightingId } });
    try {
      await prisma.sighting.create({
        data: {
          id: sightingId,
          latitude: 48.5,
          longitude: -123,
          observedAt: new Date(),
          observerEmail: 'photo-concurrency@example.invalid',
        },
      });
      await prisma.sightingPhoto.createMany({
        data: [0, 1, 2, 3].map((orderIndex) => ({
          orderIndex,
          sightingId,
          storageKey: `sightings/${sightingId}/photo-${orderIndex}-1024.webp`,
          thumbnailUrl: `https://api.example/media/${orderIndex}?variant=thumbnail`,
          url: `https://api.example/media/${orderIndex}`,
        })),
      });

      const attempts = await Promise.allSettled([0, 1].map((attempt) => (
        prisma.sightingPhoto.create({
          data: {
            orderIndex: 4,
            sightingId,
            storageKey: `sightings/${sightingId}/concurrent-${attempt}-1024.webp`,
            thumbnailUrl: `https://api.example/media/concurrent-${attempt}?variant=thumbnail`,
            url: `https://api.example/media/concurrent-${attempt}`,
          },
        })
      )));

      expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const photos = await prisma.sightingPhoto.findMany({
        orderBy: { orderIndex: 'asc' },
        where: { sightingId },
      });
      expect(photos).toHaveLength(5);
      expect(new Set(photos.map(({ orderIndex }) => orderIndex)).size).toBe(5);
    } finally {
      await prisma.sighting.deleteMany({ where: { id: sightingId } });
    }
  });

  it('preserves legacy users and sightings across the staged Task 2 upgrade', async () => {
    const baseUrl = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '');
    const schemaName = `task2_upgrade_${process.pid}_${Date.now()}`;
    const stagedUrl = new URL(baseUrl);
    stagedUrl.searchParams.set('schema', schemaName);
    stagedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fluke-task2-upgrade-'));
    const cleanupUrl = new URL(baseUrl);
    cleanupUrl.searchParams.set('schema', 'public');
    cleanupUrl.searchParams.set('options', '-csearch_path=public');
    const cleanupClient = new PrismaClient({ datasourceUrl: cleanupUrl.toString() });

    try {
      await cleanupClient.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
      const { migrationsDirectory, schemaPath } = prepareStagedMigrationDirectory(temporaryRoot);
      deployMigrations(schemaPath, stagedUrl.toString());
      await seedLegacyRows(stagedUrl.toString());
      cpSync(
        join(repositoryRoot, 'prisma/migrations/20260717170000_add_observer_submissions'),
        join(migrationsDirectory, '20260717170000_add_observer_submissions'),
        { recursive: true },
      );
      deployMigrations(schemaPath, stagedUrl.toString());
      const { sighting, users } = await readLegacyRows(stagedUrl.toString());

      expect(users).toEqual([
        {
          appleSub: null,
          email: 'legacy-admin@example.invalid',
          id: 'legacy-admin',
          passwordHash: 'known-admin-hash',
          role: 'ADMIN',
          sessionVersion: 1,
        },
        {
          appleSub: null,
          email: 'legacy-moderator@example.invalid',
          id: 'legacy-moderator',
          passwordHash: 'known-moderator-hash',
          role: 'MODERATOR',
          sessionVersion: 1,
        },
      ]);
      expect(sighting).toEqual({
        behaviorNotes: 'Known legacy behavior',
        id: 'legacy-sighting',
        latitude: '48.500000',
        locationName: 'Salish Sea legacy location',
        longitude: '-123.250000',
        moderatedBy: 'legacy-moderator',
        observedAt: '2026-07-01T12:00:00.000',
        observerEmail: 'legacy-observer@example.invalid',
        observerName: 'Known legacy observer',
        observerUserId: null,
        status: 'APPROVED',
      });
    } finally {
      await cleanupClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await cleanupClient.$disconnect();
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }, 30_000);
});
