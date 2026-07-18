# API Task 2 Report: Observer, Session, and Idempotency Schema

## Scope

Implemented only plan Task 2 from base `b7dbb97`: additive observer/account fields,
observer sighting ownership, submission idempotency storage, the migration-readiness
marker, PostgreSQL integration coverage, and the minimum legacy-admin-login guard
required by nullable observer credentials. Identification remains unchanged and
disabled by the existing feature firewall.

## RED evidence

1. `pnpm vitest run tests/migration-readiness.test.ts tests/integration/observer-submissions.postgres.test.ts`
   - Initial environment attempt could not find `vitest` in the isolated worktree.
     `pnpm install --frozen-lockfile` restored the existing lockfile dependencies.
   - Intended RED after dependency restoration: 3 failures.
     - readiness marker still returned `20260716220000_add_job_operations`;
     - Prisma schema did not contain `OBSERVER`/observer ownership/idempotency;
     - migration file did not exist.
2. `pnpm vitest run src/__tests__/auth.test.ts`
   - New passwordless-observer regression returned 500 instead of 401, proving that
     nullable credentials would break the legacy password login path without a guard.

## GREEN evidence

- Prisma formatting and validation: passed with explicit non-secret local placeholder
  `DATABASE_URL`/`DIRECT_URL` values.
- `pnpm db:generate`: passed; Prisma Client 5.22.0 generated successfully.
- Real PostgreSQL 16 migration against isolated local database
  `fluke_task2_20260717` on port 5433:
  - `pnpm db:migrate:deploy`: all 9 migrations applied successfully;
  - `pnpm db:migrate:status`: `Database schema is up to date!`;
  - `RUN_POSTGRES_INTEGRATION=true ... pnpm vitest run tests/migration-readiness.test.ts tests/integration/observer-submissions.postgres.test.ts`:
    2 files passed, 9 tests passed, 0 skipped.
- Full `pnpm test`: 39 files passed, 3 PostgreSQL-only files skipped; 282 tests
  passed, 12 skipped, 0 failed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `git diff --check`: passed.

## Compatibility and safety

- Migration is additive: it adds enum value/columns/table/indexes/foreign keys and
  only drops `NOT NULL` constraints required for optional Apple identities.
- Existing admin/moderator rows retain password hashes and null Apple identities.
- Existing sightings retain all data and receive null observer ownership.
- Deleting an observer sets sighting ownership to null; idempotency records cascade.
- Idempotency `key_hash` is globally unique.
- Passwordless/Apple observer rows fail closed with 401 in the legacy password login
  route; existing password-backed admin login remains covered.
- No production database, deployment, feature flag, or Identify behavior was touched.

## Risks and notes

- Verification ran under local Node v25.9.0 while the repository pins Node 22.17.0;
  pnpm emitted an engine warning. CI must still verify on the pinned runtime.
- The isolated local PostgreSQL test database was intentionally left in place for
  repeatable follow-up integration testing; no production data was accessed.
- `prisma format` normalized existing schema alignment, so the schema diff contains
  whitespace-only changes outside the modified models in addition to Task 2 semantics.

## Review follow-up

### RED evidence

- Added an observer-with-password login regression and a validly signed observer JWT
  regression, then ran `pnpm vitest run src/__tests__/auth.test.ts tests/release-config.test.ts`.
  Both authorization tests failed as expected: observer password login returned 200
  instead of 401, and the observer JWT reached `/auth/me` with 200 instead of 401.
- Added bcrypt call assertions for both passwordless and password-backed observers.
  The passwordless case then failed because the dummy bcrypt path ran before role
  rejection; moving runtime role validation ahead of every bcrypt call made it green.
- The release-marker coupling test passed immediately after pointing it at the Task 2
  migration; this was a test-correctness repair rather than new runtime behavior.
- The staged migration test passed on its first real PostgreSQL run. It verifies the
  existing additive SQL rather than driving a new implementation change.

### Fixes

- Password login now permits only `ADMIN` and `MODERATOR` roles before bcrypt or JWT
  issuance. An `OBSERVER` with a valid password receives 401 and no admin cookie.
- `requireAdmin` now validates the decoded JWT shape and role at runtime; a correctly
  signed token with an observer/legacy role fails closed.
- The release configuration test reads the observer-submissions migration itself and
  couples the readiness marker to its enum, ownership-column, and idempotency-table SQL.
- The PostgreSQL integration suite now creates a unique temporary schema, deploys only
  through `20260716220000_add_job_operations`, inserts legacy admin/moderator users and
  a known sighting, then adds/deploys Task 2. It verifies exact hashes, identity fields,
  moderator ownership, sighting data, null observer ownership, and session version 1.
  The temporary schema is dropped in `finally`; no production database is accessed.

### GREEN evidence

- Focused review suite with real PostgreSQL 16:
  `RUN_POSTGRES_INTEGRATION=true ... pnpm vitest run src/__tests__/auth.test.ts tests/release-config.test.ts tests/integration/observer-submissions.postgres.test.ts tests/migration-readiness.test.ts`
  passed 4 files and 38 tests, including the staged upgrade.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- Fresh full `pnpm test`: 39 files passed, 3 PostgreSQL-only files skipped; 284 tests
  passed, 13 skipped, 0 failed.
