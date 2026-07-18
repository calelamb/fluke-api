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
import FormData from 'form-data';
import { SignJWT } from 'jose';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const postgresEnabled = process.env.RUN_POSTGRES_INTEGRATION === 'true';
const integrationUploadsRoot = postgresEnabled
  ? mkdtempSync(join(tmpdir(), 'fluke-task7-route-media-'))
  : join(tmpdir(), 'fluke-task7-route-media-disabled');
if (postgresEnabled) {
  process.env.UPLOADS_DIR = integrationUploadsRoot;
  process.env.OBSERVER_JWT_SECRET = 'task7-observer-jwt-secret-that-is-more-than-forty-three-characters';
  process.env.OBSERVER_CSRF_SECRET = 'task9-observer-csrf-secret-that-is-more-than-forty-three-characters';
}

interface ObserverCookies {
  readonly csrf: string;
  readonly header: string;
  readonly session: string;
}

function observerCookies(response: { headers: Record<string, unknown> }): ObserverCookies {
  const raw = response.headers['set-cookie'];
  const values = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
  const pairs = values.map((value) => value.split(';', 1)[0]);
  const findValue = (name: string): string => {
    const pair = pairs.find((candidate) => candidate.startsWith(`${name}=`));
    if (pair === undefined) throw new Error(`Missing ${name} cookie`);
    return pair.slice(name.length + 1);
  };
  return Object.freeze({
    csrf: findValue('fluke_csrf'),
    header: pairs.join('; '),
    session: findValue('fluke_observer'),
  });
}

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
    rmSync(integrationUploadsRoot, { force: true, recursive: true });
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

  it('enforces the fifth-photo race through the upload route and compensates storage', async () => {
    const sightingId = `it-photo-route-${process.pid}`;
    const clientSubmissionId = '1c39ac39-ce63-498c-9197-48f64ebaddb7';
    const { buildApp } = await import('../../src/app.js');
    const app = await buildApp({
      features: Object.freeze({ accounts: false, identification: false, submissions: true }),
      silent: true,
    });
    await app.ready();
    try {
      await prisma.sighting.create({
        data: {
          id: sightingId, latitude: 48.5, longitude: -123,
          observedAt: new Date(), observerEmail: 'route-photo@example.invalid',
        },
      });
      await prisma.sightingPhoto.createMany({
        data: [0, 1, 2, 3].map((orderIndex) => ({
          orderIndex, sightingId, storageKey: `fixtures/${orderIndex}`,
          thumbnailUrl: `https://api.example/thumb/${orderIndex}`,
          url: `https://api.example/photo/${orderIndex}`,
        })),
      });
      const token = app.jwt.sign(
        { clientSubmissionId, sightingId, type: 'photo-upload' }, { expiresIn: '24h' },
      );
      const photos = await Promise.all(['#102030', '#f0e0d0'].map((background) => sharp({
        create: { width: 64, height: 48, channels: 3, background },
      }).png().toBuffer()));
      const responses = await Promise.all(photos.map((photo, index) => {
        const form = new FormData();
        form.append('file', photo, { filename: `race-${index}.png`, contentType: 'image/png' });
        return app.inject({
          headers: {
            ...form.getHeaders(),
            'idempotency-key': `${clientSubmissionId}:${index === 0 ? 'd362c2c9-c281-4545-b9fd-41a49cbed157' : 'ab253f94-18df-4201-965a-2aaf81ed62b1'}`,
            'x-photo-upload-token': token,
          },
          method: 'POST', payload: form, remoteAddress: `127.0.2.${index + 1}`,
          url: `/api/v1/sightings/${sightingId}/photos`,
        });
      }));

      expect(responses.filter(({ statusCode }) => statusCode === 201)).toHaveLength(1);
      expect(responses.every(({ statusCode }) => [201, 400, 503].includes(statusCode))).toBe(true);
      await expect(prisma.sightingPhoto.count({ where: { sightingId } })).resolves.toBe(5);
      const mediaDirectory = join(integrationUploadsRoot, 'sightings', sightingId);
      expect(readdirSync(mediaDirectory)).toHaveLength(2);
    } finally {
      await prisma.sighting.deleteMany({ where: { id: sightingId } });
      await app.close();
    }
  });

  it('paginates Logbook rows without crossing observer ownership', async () => {
    const firstUserId = `it-logbook-one-${process.pid}`;
    const secondUserId = `it-logbook-two-${process.pid}`;
    const ids = [`${firstUserId}-new`, `${firstUserId}-old`, `${secondUserId}-private`];
    const { buildApp } = await import('../../src/app.js');
    const app = await buildApp({
      features: Object.freeze({ accounts: true, identification: false, submissions: false }),
      silent: true,
    });
    await app.ready();
    try {
      await prisma.user.createMany({
        data: [firstUserId, secondUserId].map((id) => ({ id, role: 'OBSERVER' })),
      });
      await prisma.sighting.createMany({
        data: [
          { id: ids[0], observerUserId: firstUserId, observedAt: new Date('2026-07-17T13:00:00Z') },
          { id: ids[1], observerUserId: firstUserId, observedAt: new Date('2026-07-17T12:00:00Z') },
          { id: ids[2], observerUserId: secondUserId, observedAt: new Date('2026-07-17T14:00:00Z') },
        ].map((row) => ({
          ...row, latitude: 48.5, longitude: -123,
          observerEmail: 'logbook-fixture@example.invalid',
        })),
      });
      const session = await new SignJWT({
        role: 'OBSERVER', sessionVersion: 1, type: 'observer-session',
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setAudience('fluke-ios-observer').setIssuer('fluke-api').setSubject(firstUserId)
        .setIssuedAt().setExpirationTime('1h')
        .sign(new TextEncoder().encode(process.env.OBSERVER_JWT_SECRET));
      const first = await app.inject({
        headers: { cookie: `fluke_observer=${session}` }, method: 'GET',
        url: '/api/v1/sightings/me?limit=1',
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json<{ items: { id: string }[]; page: { nextCursor: string } }>();
      expect(firstBody.items.map(({ id }) => id)).toEqual([ids[0]]);
      const second = await app.inject({
        headers: { cookie: `fluke_observer=${session}` }, method: 'GET',
        url: `/api/v1/sightings/me?limit=1&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json<{ items: { id: string }[] }>().items.map(({ id }) => id)).toEqual([ids[1]]);
    } finally {
      await prisma.sighting.deleteMany({ where: { id: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: [firstUserId, secondUserId] } } });
      await app.close();
    }
  });

  it('runs observer sign-in, isolated submission, deletion, and session invalidation end to end', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const subjects = [`apple-one-${suffix}`, `apple-two-${suffix}`];
    const removedKeys: string[] = [];
    const revokedTokens: string[] = [];
    const appleAuth = Object.freeze({
      exchangeAppleAuthorizationCode: async (code: string) => Object.freeze({
        accessToken: `access-${code}`,
        expiresIn: 3600,
        identityToken: `exchange-${code}`,
        refreshToken: `refresh-${code}`,
        subject: code.endsWith('-two') ? subjects[1] : subjects[0],
      }),
      revokeAppleRefreshToken: async (token: string) => { revokedTokens.push(token); },
      verifyAppleIdentityToken: async (token: string) => Object.freeze({
        email: `${token}@example.invalid`,
        emailVerified: true,
        subject: token.endsWith('-two') ? subjects[1] : subjects[0],
      }),
    });
    const storage = Object.freeze({
      publicUrl: () => { throw new Error('private storage has no public URL'); },
      put: async () => Object.freeze({ key: 'unused', size: 1 }),
      remove: async (key: string) => { removedKeys.push(key); },
      signedReadUrl: async (key: string) => `https://signed.example.invalid/${key}?ttl=300`,
    });
    const tokenCrypto = Object.freeze({
      decryptToken: (ciphertext: string) => ciphertext.replace(/^encrypted:/u, ''),
      encryptToken: (token: string) => `encrypted:${token}`,
    });
    const { buildApp } = await import('../../src/app.js');
    const app = await buildApp({
      features: Object.freeze({ accounts: true, identification: false, submissions: true }),
      observerAuth: { appleAuth, storage, tokenCrypto },
      silent: true,
    });
    await app.ready();
    const createdSightingIds: string[] = [];

    const signIn = async (identity: 'one' | 'two') => {
      const response = await app.inject({
        method: 'POST',
        payload: {
          authorizationCode: `code-${identity}`,
          fullName: `Observer ${identity}`,
          identityToken: `identity-${identity}`,
          nonce: `nonce-${identity}-${'n'.repeat(32)}`,
        },
        remoteAddress: identity === 'one' ? '127.10.0.1' : '127.10.0.2',
        url: '/api/v1/auth/apple',
      });
      expect(response.statusCode).toBe(200);
      return observerCookies(response);
    };

    try {
      const firstCookies = await signIn('one');
      const secondCookies = await signIn('two');
      const firstUser = await prisma.user.findUniqueOrThrow({ where: { appleSub: subjects[0] } });
      const secondUser = await prisma.user.findUniqueOrThrow({ where: { appleSub: subjects[1] } });
      expect(firstUser.appleRefreshTokenCiphertext).toBe('encrypted:refresh-code-one');
      expect(JSON.stringify(firstUser)).not.toContain('access-code-one');

      const submissionId = '8d2704ca-7d31-49a3-9875-74126453734e';
      const submission = await app.inject({
        headers: {
          cookie: firstCookies.header,
          'idempotency-key': submissionId,
          'x-fluke-csrf': firstCookies.csrf,
        },
        method: 'POST',
        payload: {
          clientSubmissionId: submissionId,
          latitude: 48.5,
          longitude: -123,
          observedAt: '2026-07-17T12:00:00.000Z',
          observerEmail: 'first@example.invalid',
        },
        remoteAddress: '127.10.0.3',
        url: '/api/v1/sightings',
      });
      expect(submission.statusCode).toBe(201);
      const sightingId = submission.json<{ id: string }>().id;
      createdSightingIds.push(sightingId);

      const otherLogbook = await app.inject({
        headers: { cookie: secondCookies.header },
        method: 'GET',
        url: '/api/v1/sightings/me',
      });
      expect(otherLogbook.statusCode).toBe(200);
      expect(otherLogbook.json<{ items: unknown[] }>().items).toEqual([]);

      const privatePhoto = await prisma.sightingPhoto.create({
        data: {
          orderIndex: 0,
          sightingId,
          storageKey: `sightings/${sightingId}/private-1024.webp`,
          thumbnailUrl: `/api/v1/media/private-${suffix}?variant=thumbnail`,
          url: `/api/v1/media/private-${suffix}`,
        },
      });
      const forbiddenMedia = await app.inject({
        headers: { cookie: secondCookies.header },
        method: 'GET',
        url: `/api/v1/media/${privatePhoto.id}`,
      });
      expect(forbiddenMedia.statusCode).toBe(403);
      expect(forbiddenMedia.body).not.toContain(privatePhoto.storageKey);

      await prisma.sighting.update({ where: { id: sightingId }, data: { status: 'APPROVED' } });
      const publicMedia = await app.inject({ method: 'GET', url: `/api/v1/media/${privatePhoto.id}` });
      expect(publicMedia.statusCode).toBe(302);
      expect(publicMedia.headers.location).toContain('ttl=300');

      const pending = await prisma.sighting.create({
        data: {
          latitude: 48.6,
          longitude: -123.1,
          observedAt: new Date(),
          observerEmail: 'first@example.invalid',
          observerUserId: firstUser.id,
        },
      });
      createdSightingIds.push(pending.id);
      await prisma.sightingPhoto.create({
        data: {
          orderIndex: 0,
          sightingId: pending.id,
          storageKey: `sightings/${pending.id}/delete-1024.webp`,
          thumbnailUrl: `/api/v1/media/delete-${suffix}?variant=thumbnail`,
          url: `/api/v1/media/delete-${suffix}`,
        },
      });

      const deletion = await app.inject({
        headers: { cookie: firstCookies.header, 'x-fluke-csrf': firstCookies.csrf },
        method: 'DELETE',
        payload: {
          authorizationCode: 'code-one',
          identityToken: 'identity-one',
          nonce: `delete-${'n'.repeat(32)}`,
        },
        url: '/api/v1/auth/account',
      });
      expect(deletion.statusCode).toBe(200);
      await expect(prisma.user.findUnique({ where: { id: firstUser.id } })).resolves.toBeNull();
      await expect(prisma.sighting.findUnique({ where: { id: pending.id } })).resolves.toBeNull();
      await expect(prisma.sighting.findUnique({ where: { id: sightingId } })).resolves.toMatchObject({
        observerEmail: 'deleted-observer@privacy.invalid',
        observerName: null,
        observerUserId: null,
      });
      expect(revokedTokens.sort()).toEqual(['refresh-code-one']);
      expect(removedKeys).toEqual(expect.arrayContaining([
        `sightings/${pending.id}/delete-1024.webp`,
        `sightings/${pending.id}/delete-256.webp`,
      ]));

      const staleSession = await app.inject({
        headers: { cookie: `fluke_observer=${firstCookies.session}` },
        method: 'GET',
        url: '/api/v1/sightings/me',
      });
      expect(staleSession.statusCode).toBe(401);
      expect(staleSession.body).not.toContain(firstUser.email ?? 'first@example.invalid');
      expect(secondUser.role).toBe('OBSERVER');
    } finally {
      await prisma.sighting.deleteMany({ where: { id: { in: createdSightingIds } } });
      await prisma.user.deleteMany({ where: { appleSub: { in: subjects } } });
      await app.close();
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
