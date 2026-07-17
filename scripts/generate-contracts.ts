import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { contractDefinitions } from './contract-definitions.js';
import { writeJson } from './contract-io.js';

export async function generateContracts(outputRoot: string): Promise<void> {
  const fixtureRoot = resolve(outputRoot, 'fixtures');
  const schemaRoot = resolve(outputRoot, 'schemas');
  await Promise.all([
    mkdir(fixtureRoot, { recursive: true }),
    mkdir(schemaRoot, { recursive: true }),
  ]);

  await Promise.all(
    contractDefinitions.flatMap((definition) => [
      writeJson(resolve(fixtureRoot, `${definition.name}.json`), definition.fixture),
      writeJson(
        resolve(schemaRoot, `${definition.name}.schema.json`),
        zodToJsonSchema(definition.schema, {
          $refStrategy: 'none',
          name: definition.jsonSchemaTitle,
        }),
      ),
    ]),
  );
}

const cliPath = process.argv[1];
if (cliPath && import.meta.url === pathToFileURL(cliPath).href) {
  await generateContracts(resolve('contracts'));
}
