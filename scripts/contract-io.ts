import { readdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const differenceIndex = leftCodePoints.findIndex(
    (codePoint, index) => codePoint !== rightCodePoints[index],
  );
  if (differenceIndex === -1) {
    return leftCodePoints.length - rightCodePoints.length;
  }
  return leftCodePoints[differenceIndex] < rightCodePoints[differenceIndex] ? -1 : 1;
}

export function sortJsonKeys(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeys);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, child]) => [key, sortJsonKeys(child)]),
    );
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  throw new TypeError(`Cannot serialize non-JSON value of type ${typeof value}`);
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(sortJsonKeys(value), null, 2)}\n`;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, formatJson(value), 'utf8');
}

async function readDirectory(root: string) {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function listFiles(root: string): Promise<readonly string[]> {
  const entries = await readDirectory(root);
  const nestedPaths = await Promise.all(
    entries
      .slice()
      .sort((left, right) => compareCodePoints(left.name, right.name))
      .map(async (entry) => {
        const absolutePath = join(root, entry.name);
        if (entry.isDirectory()) {
          const children = await listFiles(absolutePath);
          return children.map((child) => posix.join(entry.name, child));
        }
        return entry.isFile() ? [entry.name] : [];
      }),
  );

  return nestedPaths.flat();
}
