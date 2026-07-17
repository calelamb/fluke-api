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

  it('scans the complete Git history with a pinned Gitleaks version', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('GITLEAKS_VERSION: 8.30.1');
    expect(workflow).toContain('gitleaks git --log-opts=--all --redact --no-banner .');
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

  it('documents the effective production release configuration', () => {
    const readme = readRepositoryFile('README.md');

    expect(readme).toContain('NODE_ENV=production');
    expect(readme).toContain('UPLOADS_DIR=/app/uploads');
    expect(readme).toContain('gitleaks git --log-opts=--all --redact --no-banner .');
  });
});
