import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = join(repositoryRoot, 'scripts/docker-entrypoint.sh');

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function createRuntimeFixture(migrationExitCode: number): {
  readonly app: string;
  readonly log: string;
  readonly root: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'fluke-api-entrypoint-'));
  const prismaDirectory = join(root, 'node_modules/.bin');
  const binDirectory = join(root, 'bin');
  const log = join(root, 'startup.log');
  const app = join(binDirectory, 'start-api');
  mkdirSync(prismaDirectory, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  writeExecutable(
    join(prismaDirectory, 'prisma'),
    `#!/bin/sh\nprintf 'migration:%s\\n' "$*" >> "$STARTUP_LOG"\nexit ${migrationExitCode}\n`,
  );
  writeExecutable(app, '#!/bin/sh\nprintf \'api:%s\\n\' "$*" >> "$STARTUP_LOG"\n');
  return { app, log, root };
}

describe('production Docker entrypoint', () => {
  it('applies pending migrations before starting the requested process', () => {
    const fixture = createRuntimeFixture(0);
    try {
      const result = spawnSync('sh', [entrypoint, fixture.app, 'serve'], {
        cwd: fixture.root,
        env: { ...process.env, STARTUP_LOG: fixture.log },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(readFileSync(fixture.log, 'utf8').trim().split('\n')).toEqual([
        'migration:migrate deploy',
        'api:serve',
      ]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed without starting the API when migration deployment fails', () => {
    const fixture = createRuntimeFixture(41);
    try {
      const result = spawnSync('sh', [entrypoint, fixture.app, 'serve'], {
        cwd: fixture.root,
        env: { ...process.env, STARTUP_LOG: fixture.log },
        encoding: 'utf8',
      });

      expect(result.status).toBe(41);
      expect(readFileSync(fixture.log, 'utf8')).toBe('migration:migrate deploy\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
