import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const postgresEnabled = new Set(['1', 'true']).has(
  process.env.RUN_POSTGRES_INTEGRATION ?? '',
);
const scoreSemantics = 'uncalibrated_similarity_not_probability';
const fixture = Object.freeze({
  acceptedManifestVersion: 'it-identifier-release-accepted',
  activeManifestVersion: 'it-identifier-release-active',
  catalogId: 'IT-ON-DEVICE-IDENTIFIER',
  duplicateActiveManifestVersion: 'it-identifier-release-duplicate-active',
  reviewerId: 'it-identifier-reviewer',
  sightingId: 'it-identifier-sighting',
  whaleId: 'it-identifier-whale',
});

function readRepositoryFile(relativePath: string): string {
  return readFileSync(`${repositoryRoot}${relativePath}`, 'utf8');
}

function releaseFixture(
  manifestVersion: string,
  status: Prisma.IdentifierReleaseCreateInput['status'],
  sequence: bigint,
): Prisma.IdentifierReleaseCreateInput {
  return Object.freeze({
    catalogInventory: Object.freeze({
      maximumAppBuild: 84,
      minimumAppBuild: 42,
      whaleCount: 1,
    }),
    indexVersion: 'index-v1',
    manifestVersion,
    modelId: 'miewid',
    modelVersion: 'model-v1',
    publishedAt: new Date('2026-07-18T12:00:00.000Z'),
    rightsAttestationDigest: 'sha256:identifier-release-rights-attestation',
    scoreSemantics,
    sequence,
    status,
  });
}

function suggestionFixture(
  sightingId: string,
  releaseManifestVersion: string,
): Prisma.SightingIdentificationSuggestionUncheckedCreateInput {
  return Object.freeze({
    matchedReferencePhotoIds: Object.freeze(['it-reference-photo-left']),
    releaseManifestVersion,
    scoreSemantics,
    sightingId,
    similarityScore: new Prisma.Decimal('0.8123456'),
    whaleId: fixture.whaleId,
  });
}

async function identifierReleaseTableExists(prisma: PrismaClient): Promise<boolean> {
  const [result] = await prisma.$queryRaw<Array<{ readonly tableName: string | null }>>`
    SELECT to_regclass('identifier_releases')::text AS "tableName"
  `;
  return result?.tableName !== null && result?.tableName !== undefined;
}

async function cleanupFixture(prisma: PrismaClient): Promise<void> {
  await prisma.sighting.deleteMany({ where: { id: fixture.sightingId } });
  if (await identifierReleaseTableExists(prisma)) {
    await prisma.$executeRaw`
      DELETE FROM "identifier_releases"
      WHERE "manifest_version" IN (
        ${fixture.acceptedManifestVersion},
        ${fixture.activeManifestVersion},
        ${fixture.duplicateActiveManifestVersion}
      )
    `;
  }
  await prisma.whale.deleteMany({ where: { id: fixture.whaleId } });
  await prisma.user.deleteMany({ where: { id: fixture.reviewerId } });
}

describe('on-device identifier schema contract', () => {
  it('defines additive persistence with bounded evidence and explicit delete behavior', () => {
    const schema = readRepositoryFile('prisma/schema.prisma');
    const migration = readRepositoryFile(
      'prisma/migrations/20260718120000_add_on_device_identifier/migration.sql',
    );

    expect(schema).toContain('model IdentifierRelease');
    expect(schema).toContain('model SightingIdentificationSuggestion');
    expect(schema).toContain('@db.Decimal(8, 7)');
    expect(schema).toMatch(
      /sightingId\s+String\s+@unique\s+@map\("sighting_id"\)/u,
    );
    expect(migration).toContain('identifier_releases_one_active');
    expect(migration).toContain("WHERE status = 'ACTIVE'");
    expect(migration).toContain('ON DELETE CASCADE ON UPDATE CASCADE');
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
    expect(migration).toContain('ON DELETE SET NULL ON UPDATE CASCADE');
    expect(migration).not.toMatch(/^\s*(?:DELETE FROM|DROP TABLE|TRUNCATE)\b/mu);
    expect(migration).not.toContain('client_whale_name');
    expect(migration).not.toContain('embedding');
    expect(migration).not.toContain('raw_output');
  });
});

describe.runIf(postgresEnabled)('on-device identifier persistence against PostgreSQL', () => {
  const prisma = new PrismaClient();

  beforeEach(async () => {
    await cleanupFixture(prisma);
    await prisma.user.create({
      data: { id: fixture.reviewerId, role: 'MODERATOR' },
    });
    await prisma.whale.create({
      data: {
        catalogId: fixture.catalogId,
        ecotype: 'UNKNOWN',
        id: fixture.whaleId,
      },
    });
    await prisma.sighting.create({
      data: {
        id: fixture.sightingId,
        latitude: 48.5,
        longitude: -123,
        observedAt: new Date('2026-07-18T12:05:00.000Z'),
        observerEmail: 'identifier-integration@example.invalid',
      },
    });
  });

  afterEach(async () => {
    await cleanupFixture(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('permits one active identifier release and one suggestion per sighting', async () => {
    const active = await prisma.identifierRelease.create({
      data: releaseFixture(fixture.activeManifestVersion, 'ACTIVE', 1n),
    });
    await expect(
      prisma.identifierRelease.create({
        data: releaseFixture(fixture.duplicateActiveManifestVersion, 'ACTIVE', 2n),
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const suggestion = await prisma.sightingIdentificationSuggestion.create({
      data: suggestionFixture(fixture.sightingId, active.manifestVersion),
    });
    expect(suggestion.similarityScore.toString()).toBe('0.8123456');
    expect(suggestion.scoreSemantics).toBe(scoreSemantics);
    expect(suggestion.status).toBe('PENDING');
    expect(suggestion.matchedReferencePhotoIds).toEqual(['it-reference-photo-left']);
    await expect(
      prisma.sightingIdentificationSuggestion.create({
        data: suggestionFixture(fixture.sightingId, active.manifestVersion),
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps identifier evidence canonical while allowing independent moderation', async () => {
    const active = await prisma.identifierRelease.create({
      data: releaseFixture(fixture.activeManifestVersion, 'ACTIVE', 1n),
    });
    await prisma.sightingIdentificationSuggestion.create({
      data: suggestionFixture(fixture.sightingId, active.manifestVersion),
    });
    const suggestion = await prisma.sightingIdentificationSuggestion.update({
      data: {
        reviewedAt: new Date('2026-07-18T12:10:00.000Z'),
        reviewedById: fixture.reviewerId,
        status: 'ACCEPTED',
      },
      where: { sightingId: fixture.sightingId },
    });

    expect(suggestion.whaleId).toBe(fixture.whaleId);
    expect(suggestion.releaseManifestVersion).toBe(fixture.activeManifestVersion);
    await expect(
      prisma.whale.delete({ where: { id: fixture.whaleId } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.identifierRelease.delete({
        where: { manifestVersion: fixture.activeManifestVersion },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    await prisma.user.delete({ where: { id: fixture.reviewerId } });
    await expect(
      prisma.sightingIdentificationSuggestion.findUniqueOrThrow({
        where: { sightingId: fixture.sightingId },
      }),
    ).resolves.toMatchObject({ reviewedById: null, status: 'ACCEPTED' });

    await prisma.sighting.delete({ where: { id: fixture.sightingId } });
    await expect(
      prisma.sightingIdentificationSuggestion.findUnique({
        where: { sightingId: fixture.sightingId },
      }),
    ).resolves.toBeNull();
  });

  it('allows separately versioned non-active releases', async () => {
    await expect(
      prisma.identifierRelease.create({
        data: releaseFixture(fixture.acceptedManifestVersion, 'ACCEPTED', 3n),
      }),
    ).resolves.toMatchObject({
      manifestVersion: fixture.acceptedManifestVersion,
      status: 'ACCEPTED',
    });
  });
});
