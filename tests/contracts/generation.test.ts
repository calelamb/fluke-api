import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findContractDrift } from '../../scripts/check-contracts.js';
import { contractDefinitions } from '../../scripts/contract-definitions.js';
import { formatJson, listFiles } from '../../scripts/contract-io.js';
import { generateContracts } from '../../scripts/generate-contracts.js';

const expectedFiles = contractDefinitions
  .flatMap(({ name }) => [
    `fixtures/${name}.json`,
    `schemas/${name}.schema.json`,
  ])
  .sort((left, right) => left.localeCompare(right));

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
});
