import { prisma } from '../src/db.js';
import { classifyPublicSighting } from '../src/lib/public-data-hygiene.js';

const MAX_APPROVED_RECORDS = 1_000;

async function verifyProductionData(): Promise<void> {
  const records = await prisma.sighting.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      behaviorNotes: true,
      id: true,
      locationName: true,
      observerEmail: true,
    },
    take: MAX_APPROVED_RECORDS + 1,
    where: { status: 'APPROVED' },
  });
  if (records.length > MAX_APPROVED_RECORDS) {
    throw new Error(`Approved sighting verification exceeded ${MAX_APPROVED_RECORDS} records`);
  }

  const violations = records.flatMap((record) => {
    const violation = classifyPublicSighting(record);
    return violation ? [violation] : [];
  });
  if (violations.length > 0) {
    process.stderr.write(`${JSON.stringify({ violations })}\n`);
    throw new Error(`Found ${violations.length} synthetic approved sighting(s)`);
  }
  process.stdout.write(`${JSON.stringify({ approvedRecordsChecked: records.length, violations: 0 })}\n`);
}

try {
  await verifyProductionData();
} finally {
  await prisma.$disconnect();
}
