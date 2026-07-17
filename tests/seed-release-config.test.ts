import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('seed release configuration', () => {
  it('exposes only an explicitly development-named synthetic history command', async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['db:seed-history']).toBeUndefined();
    expect(packageJson.scripts['dev:seed-history']).toBe(
      'tsx scripts/seed-historical-sightings.ts',
    );
  });

  it('checks the synthetic-history guard before the first database query', async () => {
    const source = await readFile(resolve(root, 'scripts/seed-historical-sightings.ts'), 'utf8');
    const guardIndex = source.indexOf('assertSyntheticHistoryAllowed(process.env);');
    const queryIndex = source.indexOf('prisma.sighting.count');

    expect(guardIndex).toBeGreaterThan(0);
    expect(queryIndex).toBeGreaterThan(guardIndex);
  });

  it('provides the deterministic production seed verifier command', async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const verifier = await readFile(resolve(root, 'scripts/verify-seed.ts'), 'utf8');

    expect(packageJson.scripts['db:verify-seed']).toBe('tsx scripts/verify-seed.ts');
    expect(verifier).toContain('verifyCanonicalSeedRows');
    expect(verifier).toContain('CANONICAL_WHALES');
  });
});
