import { readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sortJsonKeys(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeys);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
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

export async function listFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nestedPaths = await Promise.all(
    entries
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const absolutePath = join(root, entry.name);
        if (entry.isDirectory()) {
          const children = await listFiles(absolutePath);
          return children.map((child) => join(entry.name, child));
        }
        return entry.isFile() ? [entry.name] : [];
      }),
  );

  return nestedPaths.flat().map((path) => relative('.', path));
}
