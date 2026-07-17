import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareCodePoints, listFiles } from './contract-io.js';
import { generateContracts } from './generate-contracts.js';

export type ContractDriftKind = 'changed' | 'missing' | 'unexpected';

export interface ContractDrift {
  readonly kind: ContractDriftKind;
  readonly path: string;
}

async function filesMatch(left: string, right: string): Promise<boolean> {
  const [leftContent, rightContent] = await Promise.all([
    readFile(left),
    readFile(right),
  ]);
  return leftContent.equals(rightContent);
}

export async function compareContractTrees(
  expectedRoot: string,
  actualRoot: string,
): Promise<readonly ContractDrift[]> {
  const [expectedFiles, actualFiles] = await Promise.all([
    listFiles(expectedRoot),
    listFiles(actualRoot),
  ]);
  const expected = new Set(expectedFiles);
  const actual = new Set(actualFiles);
  const allPaths = [...new Set([...expectedFiles, ...actualFiles])].sort(compareCodePoints);

  const drift = await Promise.all(
    allPaths.map(async (path): Promise<ContractDrift | null> => {
      if (!actual.has(path)) {
        return { kind: 'missing', path };
      }
      if (!expected.has(path)) {
        return { kind: 'unexpected', path };
      }
      const matches = await filesMatch(join(expectedRoot, path), join(actualRoot, path));
      return matches ? null : { kind: 'changed', path };
    }),
  );

  return drift.filter((entry): entry is ContractDrift => entry !== null);
}

export async function findContractDrift(
  committedRoot: string,
): Promise<readonly ContractDrift[]> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fluke-contract-check-'));
  try {
    await generateContracts(temporaryRoot);
    return await compareContractTrees(temporaryRoot, committedRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function checkContracts(): Promise<void> {
  const drift = await findContractDrift(resolve('contracts'));
  if (drift.length === 0) {
    console.log('Contract artifacts are current.');
    return;
  }

  console.error('Contract artifact drift detected:');
  for (const entry of drift) {
    console.error(`- ${entry.kind}: ${entry.path}`);
  }
  process.exitCode = 1;
}

const cliPath = process.argv[1];
if (cliPath && import.meta.url === pathToFileURL(cliPath).href) {
  await checkContracts();
}
