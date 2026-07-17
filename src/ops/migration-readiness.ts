export const REQUIRED_MIGRATION = '20260717170000_add_observer_submissions' as const;

interface MigrationStatusRow {
  readonly requiredApplied: boolean;
  readonly unresolvedCount: bigint;
}

export interface MigrationQueryClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
}

export async function assertRequiredMigration(
  client: MigrationQueryClient,
): Promise<void> {
  const [status] = await client.$queryRaw<MigrationStatusRow[]>`
    SELECT
      EXISTS (
        SELECT 1
        FROM "_prisma_migrations"
        WHERE "migration_name" = ${REQUIRED_MIGRATION}
          AND "finished_at" IS NOT NULL
          AND "rolled_back_at" IS NULL
      ) AS "requiredApplied",
      (
        SELECT COUNT(*)::bigint
        FROM "_prisma_migrations"
        WHERE "finished_at" IS NULL
          AND "rolled_back_at" IS NULL
      ) AS "unresolvedCount"
  `;

  if (!status?.requiredApplied) {
    throw new Error(`Required migration ${REQUIRED_MIGRATION} is not applied`);
  }
  if (status.unresolvedCount > 0n) {
    const suffix = status.unresolvedCount === 1n ? '' : 's';
    throw new Error(`Database has ${status.unresolvedCount} unresolved migration${suffix}`);
  }
}
