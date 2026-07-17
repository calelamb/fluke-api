import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function readRepositoryFile(relativePath: string): string {
  return readFileSync(`${repositoryRoot}${relativePath}`, 'utf8');
}

function expectInOrder(document: string, fragments: readonly string[]): void {
  fragments.reduce((previousIndex, fragment) => {
    const currentIndex = document.indexOf(fragment);
    expect(currentIndex, `Missing release operation: ${fragment}`).toBeGreaterThan(-1);
    expect(currentIndex, `Out-of-order release operation: ${fragment}`).toBeGreaterThan(previousIndex);
    return currentIndex;
  }, -1);
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
      'prisma/migrations/20260717183000_bound_sighting_photo_order/migration.sql',
    );

    expect(readiness).toContain(
      "export const REQUIRED_MIGRATION = '20260717183000_bound_sighting_photo_order'",
    );
    expect(migration).toContain('CHECK ("order_index" BETWEEN 0 AND 4)');
    expect(migration).toContain('sighting_photos_sighting_id_order_index_key');
  });

  it('provides an all-or-none private storage fixture to the production container smoke', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');
    for (const value of [
      'STORAGE_BACKEND=s3',
      'OBJECT_STORAGE_ACCESS_KEY_ID=ci-access-key',
      'OBJECT_STORAGE_BUCKET=fluke-ci-private',
      'OBJECT_STORAGE_ENDPOINT=https://objects.ci.invalid',
      'OBJECT_STORAGE_FORCE_PATH_STYLE=true',
      'OBJECT_STORAGE_REGION=us-west-2',
      'OBJECT_STORAGE_SECRET_ACCESS_KEY=ci-secret-key',
    ]) {
      expect(workflow).toContain(`-e ${value}`);
    }
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

  it('documents the same-SHA observer launch sequence and identify stop gate', () => {
    const deployment = readRepositoryFile('docs/deployment.md');

    expectInOrder(deployment, [
      '## Same-SHA CI gate',
      '## Database gate',
      '## Configure secrets while mutations remain off',
      '## Safe all-off deploy',
      '## Enable observer launch state',
      '## Physical TestFlight Apple gate',
    ]);
    for (const gate of [
      'GitHub Actions commit SHA must equal the Render source commit SHA',
      'Neon restore point',
      '20260717170000_add_observer_submissions',
      'ENABLE_ACCOUNTS=false',
      '/api/v1/health',
      'physical TestFlight device',
      'PRODUCTION_MUTATIONS_ACK=true',
      '{"accounts":true,"identification":false,"submissions":true}',
      'media survives an API redeploy',
    ]) {
      expect(deployment).toContain(gate);
    }
    expect(deployment).toContain('ENABLE_SUBMISSIONS=true');
    expect(deployment).toContain('ENABLE_IDENTIFY=false');
    expect(deployment).toContain('POST /api/v1/identify must return 404');
    expect(deployment).toContain('Render Free');
    expect(deployment).toContain('Do not upgrade');
  });

  it('defines fake-free production certification with explicit stop conditions', () => {
    const operations = readRepositoryFile('docs/observer-operations.md');

    for (const operation of [
      'anonymous submission',
      'signed submission',
      'exact offline replay',
      '/api/v1/sightings/me',
      'Observer A',
      'Observer B',
      'signed media',
      'DELETE /api/v1/auth/account',
      'Apple authorization',
      'orphaned object',
      'one database row',
    ]) {
      expect(operations).toContain(operation);
    }
    for (const stopCondition of [
      'non-200 health or readiness',
      'migration',
      'storage cleanup',
      'Apple verification',
      'capability mismatch',
      'Identify route exposure',
      'cross-user access',
      'duplicate replay row',
      'failed deletion',
    ]) {
      expect(operations).toContain(stopCondition);
    }
  });

  it('rolls observer flags off before reverting code while preserving durable state', () => {
    const rollback = readRepositoryFile('docs/rollback.md');

    expectInOrder(rollback, [
      'ENABLE_ACCOUNTS=false',
      'ENABLE_SUBMISSIONS=false',
      'ENABLE_IDENTIFY=false',
      'redeploy',
      'return 404',
      'preserve the database and private object bucket',
      'redeploy the previous image',
    ]);
    expect(rollback).toContain('/api/v1/health');
    expect(rollback).toContain('/api/v1/ready');
  });

  it('restores into a recorded database identity and reconciles observer security state', () => {
    const restore = readRepositoryFile('docs/restore.md');

    for (const requirement of [
      'Neon restore point',
      'database identity',
      'object inventory',
      'reconciliation',
      'sessionVersion',
      'no restored observer session becomes valid',
      'OBSERVER_JWT_SECRET',
      'OBSERVER_CSRF_SECRET',
      'APPLE_TOKEN_ENCRYPTION_KEY',
      'object-storage credentials',
    ]) {
      expect(restore).toContain(requirement);
    }
  });

  it('requires a successful all-off rollback drill before production certification', () => {
    const deployment = readRepositoryFile('docs/deployment.md');
    const drill = deployment.slice(deployment.indexOf('## Mandatory rollback drill'));

    expectInOrder(drill, [
      '## Mandatory rollback drill',
      '{"accounts":false,"identification":false,"submissions":false}',
      'canonical `404`',
      'healthy browse',
      'controlled same-commit re-enable',
      'Do not certify',
    ]);
    expect(deployment).toContain('Record the rollback drill evidence');
  });

  it('invalidates restored sessions through a bounded transaction and non-public verifier', () => {
    const restore = readRepositoryFile('docs/restore.md');

    for (const requirement of [
      'BEGIN;',
      'GREATEST("session_version", :incidentMaxSessionVersion) + 1',
      ':incidentMaxSessionVersion BETWEEN 1 AND 2147483646',
      'COMMIT;',
      'isolated non-public verifier',
      'production service remains all-off',
      'GET /api/v1/auth/me',
      'canonical `401`',
    ]) {
      expect(restore).toContain(requirement);
    }
  });

  it('matches GitHub and Render source commits without conflating the image digest', () => {
    const deployment = readRepositoryFile('docs/deployment.md');

    expect(deployment).toContain(
      'GitHub Actions commit SHA must equal the Render source commit SHA',
    );
    expect(deployment).toContain('Render image digest is a separate artifact');
    expect(deployment).not.toContain('image SHA');
  });

  it('proves account deletion with fresh physical Apple credentials and subject continuity', () => {
    const operations = readRepositoryFile('docs/observer-operations.md');

    for (const requirement of [
      'fresh authorization code',
      'fresh identityToken',
      'fresh nonce',
      'verified Apple subject',
      'token exchange',
      'Apple revocation',
    ]) {
      expect(operations).toContain(requirement);
    }
  });

  it('uses same-commit CI compensation evidence instead of injecting a production failure', () => {
    const operations = readRepositoryFile('docs/observer-operations.md');

    expect(operations).toContain('Do not inject a storage or database failure into production');
    expect(operations).toContain('same Git commit');
    expect(operations).toContain('injected post-storage database failure');
    expect(operations).toContain('normal disposable upload');
    expect(operations).toContain('before-and-after object inventory');
  });

  it('requires exact public privacy probes and records matching App Store answers', () => {
    const deployment = readRepositoryFile('docs/deployment.md');

    expect(deployment).toContain('GET https://fluke-pnw.vercel.app/privacy must return `200`');
    expect(deployment).toContain('GET https://fluke-pnw.vercel.app/support must return `200`');
    for (const disclosure of [
      'Apple account identifier',
      'observer email',
      'submitted coarse location',
      'notes and photos',
      'retention and deletion',
      'private object-storage processor',
    ]) {
      expect(deployment).toContain(disclosure);
    }
  });

  it('keeps Neon and object storage within verified zero-cost quotas', () => {
    const deployment = readRepositoryFile('docs/deployment.md');

    expect(deployment).toContain('Neon free-plan quota');
    expect(deployment).toContain('object-storage free-tier quota');
    expect(deployment).toContain('projected launch usage remains within both');
    expect(deployment).toContain('no payment method');
  });

  it('probes every disabled observer route with exact methods and canonical envelopes', () => {
    const rollback = readRepositoryFile('docs/rollback.md');

    for (const route of [
      'POST `/api/v1/auth/apple`',
      'GET `/api/v1/auth/me`',
      'POST `/api/v1/auth/logout`',
      'DELETE `/api/v1/auth/account`',
      'GET `/api/v1/sightings/me`',
      'POST `/api/v1/sightings`',
      'POST `/api/v1/sightings/:id/photos`',
      'POST `/api/v1/identify`',
    ]) {
      expect(rollback).toContain(route);
    }
    expect(rollback).toContain(
      '`{"code":"NOT_FOUND","message":"The requested resource was not found.","requestId":"<non-empty>","retryable":false}`',
    );
  });

  it('uses two distinct single-use Apple authorizations for account deletion', () => {
    const operations = readRepositoryFile('docs/observer-operations.md');

    expectInOrder(operations, [
      'Authorization A',
      'POST `/api/v1/auth/apple`',
      'exchanged exactly once',
      'Authorization B',
      'immediately before `DELETE /api/v1/auth/account`',
      'DELETE request body',
      'stored refresh token',
      'reauthentication refresh token',
      'revoke both',
    ]);
    expect(operations).toContain('authorizationCode`, `identityToken`, and `nonce`');
    expect(operations).toContain('must be distinct');
  });

  it('bounds restored and incident session maxima before the invalidating increment', () => {
    const restore = readRepositoryFile('docs/restore.md');

    expect(restore).toContain('MAX("session_version") AS "restoredMaxSessionVersion"');
    expect(restore).toContain(':restoredMaxSessionVersion BETWEEN 1 AND 2147483646');
    expect(restore).toContain(':incidentMaxSessionVersion BETWEEN 1 AND 2147483646');
    expect(restore).toContain('current restored maximum is `2147483647`');
    expect(restore).toContain('stop and escalate');
    expect(restore).toContain(
      'GREATEST("session_version", :incidentMaxSessionVersion) + 1',
    );
  });
});
