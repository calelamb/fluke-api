# API Task 7 Report: Idempotent Submit and Observer Logbook

## Outcome

Implemented Task 7 from base `d6fa20c` without enabling production flags or identification.

- `POST /api/v1/sightings` now resolves optional observer sessions before writes, rejects present-invalid observer cookies through the existing fail-closed resolver, requires CSRF only for authenticated observers, binds ownership to `observerUserId`, and preserves anonymous submission.
- Submission idempotency hashes the raw client UUID before persistence and hashes a canonical validated payload plus ownership scope. Exact replays return the original sighting with HTTP 200; changed payload or owner returns canonical HTTP 409.
- Creation and the idempotency record share a serializable transaction. Prisma unique/serialization races reread the committed winner, preventing response-loss duplicates.
- Photo upload tokens include the sighting `clientSubmissionId`. The iOS photo key `<clientSubmissionId>:<photoUUID>` is validated against that private token, mapped to a deterministic non-secret photo ID, and serialized with a PostgreSQL advisory transaction lock. Exact image replays return HTTP 200; changed content/key scope conflicts; the existing max-five unique ordering and storage compensation remain intact.
- `GET /api/v1/sightings/me` requires an observer session, applies observer ownership in the query, uses bounded opaque cursor pagination, selects only Logbook fields, and does not expose observer identity or private storage keys.
- The PostgreSQL integration harness now supplies `search_path` as well as Prisma's schema selector so raw SQL and ORM queries use the same isolated test schema.

## TDD Evidence

Initial focused RED run: 5 expected failures across the submission and Logbook suites (missing idempotency module, missing Logbook route, replay created again, mismatch did not conflict, and authenticated submit did not invoke CSRF).

Focused GREEN:

```text
src/__tests__/observer-sightings.test.ts  1 passed
src/__tests__/sightings.test.ts           9 passed
src/__tests__/sighting-photos.test.ts     22 passed
32 passed, 0 failed
```

Real isolated PostgreSQL GREEN:

```text
tests/integration/observer-submissions.postgres.test.ts  8 passed
- concurrent response-loss replay: 200 + 201, one durable sighting
- changed owner with same client key: 409
- global idempotency uniqueness: enforced
- concurrent fifth photo: one winner
- ownership deletion and staged legacy migration: passed
```

## Full Verification

```text
pnpm test
  48 files passed, 3 PostgreSQL-only suites skipped
  432 tests passed, 15 skipped, 0 failed

pnpm test:coverage
  statements 91.29%
  branches   85.45%
  functions  95.03%
  lines      91.29%

pnpm typecheck       passed
pnpm lint            passed
pnpm contracts:generate && pnpm contracts:check  passed/current
pnpm audit --prod --audit-level=high             no known vulnerabilities
pnpm build           passed
git diff --check     passed
```

## Security/Scope Review

- No tokens, idempotency hashes, email addresses, raw request bodies, or private object keys are logged.
- No credentials or production configuration were added.
- `ENABLE_IDENTIFY` and production capability flags were not changed.
- No deploy, live bucket operation, or capability enablement was performed.

## Independent Review Fixes

All four Important findings and the Minor finding from the first independent review were addressed under focused RED/GREEN tests:

1. Photo mutation authorization now requires admin authorization, a valid sighting-scoped private upload token, or the owning observer plus CSRF. Anonymous-by-ID, cross-owner, and present-invalid observer-cookie cases are rejected.
2. A serialization failure with no visible winner now retries the complete serializable submission transaction, bounded to three attempts.
3. Idempotent photo storage tracks both stored keys outside the transaction and compensates them if the outer Prisma transaction fails after its callback completed.
4. The isolated PostgreSQL suite now exercises the real multipart upload route under a concurrent fifth-photo race and the real Logbook route across two users and a cursor boundary.
5. Photo request fingerprints now persist and compare the complete SHA-256 digest; a changed-bytes replay test and a full-digest storage assertion cover the contract.

Second verification snapshot:

```text
Exact Node 22.17.0 full suite:
  48 files passed, 3 PostgreSQL-only suites skipped
  438 tests passed, 17 skipped, 0 failed

Exact Node 22.17.0 coverage:
  statements 91.41%
  branches   85.79%
  functions  94.73%
  lines      91.41%

Real isolated PostgreSQL:
  10 tests passed, including route-level fifth-photo/storage compensation
  and cross-user cursor-bounded Logbook isolation

Exact Node 22.17.0 typecheck, lint, contract generation/check, audit, and build passed.
```

No production flag, deployment, identification route, or live object bucket was changed.
