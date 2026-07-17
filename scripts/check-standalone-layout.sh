#!/usr/bin/env bash
set -euo pipefail

required=(
  package.json
  src/app.ts
  src/index.ts
  prisma/schema.prisma
  scripts/create-admin.ts
  tsconfig.json
  vitest.config.ts
)

for path in "${required[@]}"; do
  test -f "${path}" || {
    echo "missing required standalone path: ${path}" >&2
    exit 1
  }
done

test ! -d apps/api || {
  echo 'apps/api must not exist in the standalone repository' >&2
  exit 1
}

# Keep packages/shared temporarily: Task 3 migrates these contracts into
# API-owned modules and removes the legacy workspace package only after its
# compatibility tests pass.
