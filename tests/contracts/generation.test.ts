import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findContractDrift } from '../../scripts/check-contracts.js';
import { contractDefinitions } from '../../scripts/contract-definitions.js';
import {
  compareCodePoints,
  formatJson,
  listFiles,
} from '../../scripts/contract-io.js';
import { generateContracts } from '../../scripts/generate-contracts.js';

const expectedFiles = contractDefinitions
  .flatMap(({ name }) => [
    `fixtures/${name}.json`,
    `schemas/${name}.schema.json`,
  ])
  .sort(compareCodePoints);

async function withTemporaryDirectory<T>(
  prefix: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readTree(root: string): Promise<readonly string[]> {
  const files = await listFiles(root);
  return await Promise.all(files.map((path) => readFile(join(root, path), 'utf8')));
}

describe('contract generation', () => {
  it('writes the exact deterministic artifact set', async () => {
    await withTemporaryDirectory('fluke-contracts-a-', async (first) => {
      await withTemporaryDirectory('fluke-contracts-b-', async (second) => {
        await Promise.all([generateContracts(first), generateContracts(second)]);

        const [firstFiles, secondFiles] = await Promise.all([
          listFiles(first),
          listFiles(second),
        ]);
        expect(firstFiles).toEqual(expectedFiles);
        expect(secondFiles).toEqual(expectedFiles);

        const [firstTree, secondTree] = await Promise.all([
          readTree(first),
          readTree(second),
        ]);
        expect(firstTree).toEqual(secondTree);
      });
    });
  });

  it('publishes canonical JSON and fixtures accepted by their Zod schemas', async () => {
    await withTemporaryDirectory('fluke-contracts-valid-', async (root) => {
      await generateContracts(root);

      await Promise.all(
        contractDefinitions.map(async ({ name, schema }) => {
          const fixtureText = await readFile(join(root, 'fixtures', `${name}.json`), 'utf8');
          const fixture: unknown = JSON.parse(fixtureText);
          expect(schema.safeParse(fixture).success, `${name} fixture`).toBe(true);
          expect(fixtureText).toBe(formatJson(fixture));

          const schemaText = await readFile(
            join(root, 'schemas', `${name}.schema.json`),
            'utf8',
          );
          const jsonSchema = JSON.parse(schemaText) as { $schema?: unknown };
          expect(jsonSchema.$schema, `${name} JSON Schema dialect`).toBe(
            'http://json-schema.org/draft-07/schema#',
          );
          expect(schemaText).toBe(formatJson(jsonSchema));
        }),
      );

      const fixtureCorpus = (
        await Promise.all(
          contractDefinitions.map(({ name }) =>
            readFile(join(root, 'fixtures', `${name}.json`), 'utf8'),
          ),
        )
      ).join('\n');
      expect(fixtureCorpus).not.toMatch(/J35|J17|J57|Tahlequah|Princess Angeline|Phoenix/);

      const safeError = JSON.parse(
        await readFile(join(root, 'fixtures', 'safe-error.json'), 'utf8'),
      ) as unknown;
      expect(safeError).toEqual({
        code: 'NOT_FOUND',
        message: 'Requested fixture resource was not found.',
        requestId: 'fixture-request-1',
        retryable: false,
      });

      const whaleTrack = JSON.parse(
        await readFile(join(root, 'fixtures', 'whale-track.json'), 'utf8'),
      ) as { catalogId?: unknown; points?: unknown; whaleId?: unknown };
      expect(whaleTrack.whaleId).toBe('fixture-whale-alpha');
      expect(whaleTrack.catalogId).toBe('FX-001');
      expect(whaleTrack.points).toHaveLength(1);
    });
  });

  it('reports changed, missing, and unexpected artifact paths', async () => {
    await withTemporaryDirectory('fluke-contracts-drift-', async (root) => {
      await generateContracts(root);
      await Promise.all([
        rm(join(root, 'fixtures', 'health.json')),
        writeFile(join(root, 'fixtures', 'unexpected.json'), '{}\n', 'utf8'),
        writeFile(join(root, 'fixtures', 'whales.json'), '{}\n', 'utf8'),
      ]);

      await expect(findContractDrift(root)).resolves.toEqual([
        { kind: 'missing', path: 'fixtures/health.json' },
        { kind: 'unexpected', path: 'fixtures/unexpected.json' },
        { kind: 'changed', path: 'fixtures/whales.json' },
      ]);
    });
  });

  it('reports every artifact missing when the checked-in root does not exist', async () => {
    await withTemporaryDirectory('fluke-contracts-absent-', async (parent) => {
      const absentRoot = join(parent, 'contracts');

      const drift = await findContractDrift(absentRoot);

      expect(drift).toHaveLength(expectedFiles.length);
      expect(drift).toEqual(
        expectedFiles.map((path) => ({ kind: 'missing', path })),
      );
    });
  });

  it('uses code-point ordering for file paths', async () => {
    await withTemporaryDirectory('fluke-contracts-order-', async (root) => {
      await mkdir(join(root, 'fixtures'));
      await Promise.all([
        writeFile(join(root, 'fixtures', 'a.json'), '{}\n', 'utf8'),
        writeFile(join(root, 'fixtures', 'Z.json'), '{}\n', 'utf8'),
      ]);

      await expect(listFiles(root)).resolves.toEqual([
        'fixtures/Z.json',
        'fixtures/a.json',
      ]);
    });
  });
});
