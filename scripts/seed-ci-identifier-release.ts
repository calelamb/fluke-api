import { PrismaClient } from '@prisma/client';
import { assertCiIdentifierReleaseSeedAllowed } from '../src/ops/ci-identifier-release-guard.js';

const CATALOG_ID = 'CI-ON-DEVICE-ORCA';
const MANIFEST_VERSION = 'ci-on-device-certified-v1';
const PUBLISHED_AT = new Date('2026-07-19T00:00:00.000Z');
const REFERENCE_PHOTO_ID = 'ci-reference-photo-left';
const RIGHTS_DIGEST = `sha256:${'0'.repeat(64)}`;
const SCORE_SEMANTICS = 'uncalibrated_similarity_not_probability';
const WHALE_ID = 'ci-on-device-orca';

async function seedCertifiedRelease(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    await transaction.whale.create({
      data: { catalogId: CATALOG_ID, ecotype: 'UNKNOWN', id: WHALE_ID },
    });
    await transaction.identifierRelease.create({
      data: {
        catalogInventory: [{ catalogId: CATALOG_ID, referencePhotoId: REFERENCE_PHOTO_ID }],
        indexVersion: 'ci-index-v1',
        manifestVersion: MANIFEST_VERSION,
        modelId: 'ci-model',
        modelVersion: 'ci-model-v1',
        publishedAt: PUBLISHED_AT,
        rightsAttestationDigest: RIGHTS_DIGEST,
        scoreSemantics: SCORE_SEMANTICS,
        sequence: 1n,
        status: 'ACTIVE',
      },
    });
  });
}

async function main(): Promise<void> {
  assertCiIdentifierReleaseSeedAllowed(process.env);
  const prisma = new PrismaClient();
  try {
    await seedCertifiedRelease(prisma);
    console.log(`Seeded isolated CI identifier release ${MANIFEST_VERSION}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to seed the isolated CI identifier release fixture.', error);
  process.exitCode = 1;
});
