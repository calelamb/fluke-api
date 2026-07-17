import { PrismaClient } from '@prisma/client';
import {
  CANONICAL_WHALES,
  SeedVerificationError,
  verifyCanonicalSeedRows,
} from '../src/ops/seed-verifier.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const rows = await prisma.whale.findMany({
    where: {
      catalogId: { in: CANONICAL_WHALES.map(({ catalogId }) => catalogId) },
    },
    select: {
      catalogId: true,
      name: true,
      ecotype: true,
      pod: true,
      biography: true,
      mother: { select: { catalogId: true } },
      sourceCitations: true,
    },
  });

  const report = verifyCanonicalSeedRows(rows);
  process.stdout.write(`${JSON.stringify({ status: 'ok', ...report })}\n`);
}

main()
  .catch((error: unknown) => {
    const message =
      error instanceof SeedVerificationError
        ? error.message
        : 'Seed verification could not complete.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
