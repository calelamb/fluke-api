import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function readRepositoryFile(relativePath: string): string {
  return readFileSync(`${repositoryRoot}${relativePath}`, 'utf8');
}

describe('release configuration', () => {
  it('smokes the pruned runtime with production settings', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toContain('-e NODE_ENV=production');
    expect(workflow).not.toMatch(/^\s+-e NODE_ENV \\$/mu);
  });

  it('retains a stopped smoke container long enough to report its failure', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).not.toContain('docker run --rm');
    expect(workflow).toContain("docker inspect --format '{{.State.Running}}' fluke-api-ci");
    expect(workflow).toContain('docker logs fluke-api-ci');
    expect(workflow).toContain('docker rm --force fluke-api-ci');
  });

  it('scans the complete Git history with a pinned Gitleaks version', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('GITLEAKS_VERSION: 8.30.1');
    expect(workflow).toContain('gitleaks git --log-opts=--all --redact --no-banner .');
  });

  it('verifies migrations and repeatable canonical seed data in CI', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toContain('- run: pnpm db:migrate:status');
    expect(workflow.match(/- run: pnpm db:seed$/gmu)).toHaveLength(2);
    expect(workflow).toContain('- run: pnpm db:verify-seed');
  });

  it('grants read-only PR access and disables Gitleaks comments', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toMatch(/permissions:\n  contents: read\n  pull-requests: read/u);
    expect(workflow).toContain('GITLEAKS_ENABLE_COMMENTS: "false"');
  });

  it('uses the writable uploads directory in the runtime image', () => {
    const dockerfile = readRepositoryFile('Dockerfile');

    expect(dockerfile).toContain('ENV UPLOADS_DIR=/app/uploads');
    expect(dockerfile).toContain('RUN mkdir -p /app/uploads && chown node:node /app/uploads');
  });

  it('runs production migrations before Railway starts the API image', () => {
    const railwayConfig = JSON.parse(readRepositoryFile('railway.json')) as {
      deploy?: { preDeployCommand?: string[] };
    };
    const packageJson = JSON.parse(readRepositoryFile('package.json')) as {
      dependencies?: Record<string, string>;
    };

    expect(railwayConfig.deploy?.preDeployCommand).toEqual([
      'npm run db:migrate:deploy',
    ]);
    expect(packageJson.dependencies?.prisma).toBe('5.22.0');
  });

  it('runs every scheduled job through the compiled fenced CLI', () => {
    const packageJson = JSON.parse(readRepositoryFile('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['jobs:acartia']).toBe('tsx scripts/run-job.ts acartia');
    expect(packageJson.scripts?.['jobs:gbif']).toBe('tsx scripts/run-job.ts gbif');
    expect(packageJson.scripts?.['jobs:predictions']).toBe('tsx scripts/run-job.ts predictions');
    expect(packageJson.scripts?.['jobs:acartia:runtime']).toBe(
      'node dist/scripts/run-job.js acartia',
    );
    expect(packageJson.scripts?.['jobs:gbif:runtime']).toBe(
      'node dist/scripts/run-job.js gbif',
    );
    expect(packageJson.scripts?.['jobs:predictions:runtime']).toBe(
      'node dist/scripts/run-job.js predictions',
    );
    expect(packageJson.scripts?.['ingest:acartia']).toBeUndefined();
    expect(packageJson.scripts?.['ingest:gbif']).toBeUndefined();
    expect(packageJson.scripts?.['predict:compute']).toBeUndefined();
  });

  it('documents seed operations that exist in the pruned runtime image', () => {
    const packageJson = JSON.parse(readRepositoryFile('package.json')) as {
      scripts?: Record<string, string>;
    };
    const deployment = readRepositoryFile('docs/deployment.md');
    const restore = readRepositoryFile('docs/restore.md');

    expect(packageJson.scripts?.['db:seed:runtime']).toBe('node dist/prisma/seed.js');
    expect(deployment).toContain('npm run db:seed:runtime');
    expect(deployment).toContain('npm run db:verify-seed:runtime');
    expect(restore).toContain('npm run db:verify-seed:runtime');
    expect(deployment).not.toContain('`pnpm db:seed`');
    expect(restore).not.toContain('`pnpm db:');
  });

  it.each([
    ['railway.acartia.json', 'npm run jobs:acartia:runtime', '15 */6 * * *'],
    ['railway.gbif.json', 'npm run jobs:gbif:runtime', '15 2 * * 0'],
    ['railway.predictions.json', 'npm run jobs:predictions:runtime', '0 4 * * *'],
  ] as const)('defines a fail-closed Railway cron in %s', (file, startCommand, cronSchedule) => {
    const config = JSON.parse(readRepositoryFile(file)) as {
      deploy?: Record<string, unknown>;
    };

    expect(config.deploy).toMatchObject({
      cronSchedule,
      restartPolicyType: 'NEVER',
      startCommand,
    });
    expect(config.deploy).not.toHaveProperty('preDeployCommand');
    expect(config.deploy).not.toHaveProperty('healthcheckPath');
  });

  it('keeps the required migration marker aligned with the latest migration', () => {
    const readiness = readRepositoryFile('src/ops/migration-readiness.ts');
    const migration = readRepositoryFile(
      'prisma/migrations/20260716220000_add_job_operations/migration.sql',
    );

    expect(readiness).toContain(
      "export const REQUIRED_MIGRATION = '20260717170000_add_observer_submissions'",
    );
    expect(migration).toContain('CREATE TABLE "job_leases"');
    expect(migration).toContain('CREATE TABLE "job_run_events"');
    expect(migration).toContain('job_run_events_are_append_only');
  });

  it('uses an OpenSSL-equipped base for Prisma generation and runtime', () => {
    const dockerfile = readRepositoryFile('Dockerfile');

    expect(dockerfile).toContain('FROM node:22.17.0-bookworm-slim AS base');
    expect(dockerfile).toMatch(/apt-get install[^\n]*openssl/u);
    expect(dockerfile).toContain('FROM base AS build');
    expect(dockerfile).toContain('FROM base AS runtime');
  });

  it('documents the effective production release configuration', () => {
    const readme = readRepositoryFile('README.md');

    expect(readme).toContain('NODE_ENV=production');
    expect(readme).toContain('UPLOADS_DIR=/app/uploads');
    expect(readme).toContain('gitleaks git --log-opts=--all --redact --no-banner .');
    expect(readme).toContain('docs/deployment.md');
    expect(readme).toContain('docs/rollback.md');
    expect(readme).toContain('docs/restore.md');
    expect(readme).toContain('docs/scheduled-jobs.md');
  });

  it('installs bounded signal shutdown and disconnects Prisma', () => {
    const entrypoint = readRepositoryFile('src/index.ts');

    expect(entrypoint).toContain("process.once('SIGTERM'");
    expect(entrypoint).toContain("process.once('SIGINT'");
    expect(entrypoint).toContain('SHUTDOWN_TIMEOUT_MS');
    expect(entrypoint).toContain('Promise.race([closeResources(), timeoutPromise])');
    expect(entrypoint).toContain('prisma.$disconnect()');
    expect(entrypoint).toContain('process.exit(1)');
  });
});
