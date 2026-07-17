import { S3Client } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { S3StorageBackend } from '../src/lib/s3-storage.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function readRepositoryFile(relativePath: string): string {
  return readFileSync(`${repositoryRoot}${relativePath}`, 'utf8');
}

describe('observer release security gates', () => {
  it('enforces every coverage dimension at eighty percent', () => {
    const config = readRepositoryFile('vitest.config.ts');

    expect(config).toContain('branches: 80');
    expect(config).toContain('functions: 80');
    expect(config).toContain('lines: 80');
    expect(config).toContain('statements: 80');
  });

  it('generates an ephemeral Apple signing key and never reads one from repository secrets', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toContain('openssl genpkey -algorithm EC');
    expect(workflow).toContain('prime256v1');
    expect(workflow).not.toMatch(/secrets\.APPLE_PRIVATE_KEY/u);
  });

  it('pins a local S3-compatible service and creates a private test bucket', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toMatch(/quay\.io\/minio\/minio:RELEASE\.[0-9TZ-]+/u);
    expect(workflow).toContain('mc mb --ignore-existing local/fluke-ci-private');
    expect(workflow).toContain('mc anonymous set none local/fluke-ci-private');
  });

  it('certifies both production feature modes and keeps identify unavailable', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toContain('mode: [release-a, release-b]');
    expect(workflow).toContain(`'{"accounts":true,"identification":false,"submissions":true}'`);
    expect(workflow).toContain("= '404'");
  });

  it('runs migrations, contracts, quality, security, and image gates', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    for (const gate of [
      'pnpm db:migrate:deploy',
      'pnpm db:migrate:status',
      'pnpm contracts:check',
      'pnpm typecheck',
      'pnpm lint',
      'pnpm test:coverage',
      'pnpm audit',
      'gitleaks git',
      'docker/build-push-action',
    ]) {
      expect(workflow).toContain(gate);
    }
  });
});

describe.runIf(process.env.RUN_S3_INTEGRATION === 'true')('private S3 integration', () => {
  it('writes, signs, reads, and removes a private object through the local adapter', async () => {
    const endpoint = process.env.CI_S3_ENDPOINT;
    if (endpoint === undefined) throw new Error('CI_S3_ENDPOINT is required');
    const credentials = Object.freeze({
      accessKeyId: process.env.MINIO_ROOT_USER ?? '',
      secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? '',
    });
    const client = new S3Client({
      credentials,
      endpoint,
      forcePathStyle: true,
      region: 'us-west-2',
    });
    const storage = new S3StorageBackend({
      ...credentials,
      bucket: process.env.OBJECT_STORAGE_BUCKET ?? '',
      endpoint: 'https://objects.ci.example.com',
      forcePathStyle: true,
      region: 'us-west-2',
    }, client);
    const body = Buffer.from('private-ci-image');
    const stored = await storage.put({
      body,
      contentType: 'image/webp',
      filename: `task9-${process.pid}.webp`,
      prefix: 'ci/security',
    });

    try {
      const signedUrl = await storage.signedReadUrl(stored.key);
      const response = await fetch(signedUrl);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    } finally {
      await storage.remove(stored.key);
      client.destroy();
    }
  });
});
