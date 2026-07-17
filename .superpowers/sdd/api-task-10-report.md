# API Task 10 Report

Status: DONE_WITH_CONCERNS

## Scope implemented

- Replaced the Release A-only deployment notes with an operator-executable observer launch runbook for the existing Render Free, Neon, and private S3-compatible topology.
- Locked every launch artifact to the same Git SHA and recorded explicit stop conditions for CI, migration, readiness, capabilities, Apple, storage, ownership, replay, and deletion failures.
- Documented the required `20260717170000_add_observer_submissions` migration, complete Apple/observer/storage secret groups, safe all-off deployment, exact enabled capability state, and permanently disabled Identify route.
- Added a fake-free production certification checklist for physical TestFlight Apple sign-in, anonymous/signed submissions, exact response-loss replay, Logbook/media isolation, signed media, cleanup compensation, deletion/revocation, and media durability across a same-SHA Render redeploy.
- Reworked rollback to close accounts/submissions first while keeping Identify off, verify route closure, preserve database/media, and only then deploy the prior green image.
- Expanded restore into a new Neon database identity with two-way object reconciliation, observer session-version invalidation, compromise-aware key rotation, and a mandatory all-off cutover.
- Kept Render Free as the supported host and explicitly prohibited a paid upgrade without a separate cost decision.

## TDD evidence

Focused command:

```text
pnpm vitest run tests/release-config.test.ts
```

Observed RED: 4 expected failures for the absent same-SHA observer launch sequence, missing `docs/observer-operations.md`, rollback flags not being closed before code reversion, and missing restore/media/session reconciliation.

Observed GREEN after the runbooks were implemented: 21 tests passed.

## Executable-order correction

The written task sequence placed fake-free production Apple sign-in after the all-off deploy but before enabling accounts. Source review showed `/api/v1/auth/apple` is intentionally unregistered while `ENABLE_ACCOUNTS=false`, and production requires accounts/submissions to be enabled together. The runbook therefore uses the executable fail-closed order: certify all-off, atomically deploy the exact allowed enabled state, immediately run the physical TestFlight Apple gate before announcing access, and restore all-off on any failure.

## Fresh verification

Runtime:

```text
Node v22.17.0
pnpm 10.33.0
PostgreSQL 16 temporary local cluster on port 55442
```

Fresh commands and results:

- `pnpm db:generate` — passed.
- `pnpm db:migrate:deploy` — passed; all 10 migrations applied to an empty PostgreSQL database.
- `pnpm db:migrate:status` — passed; schema current.
- `pnpm layout:check` — passed.
- `pnpm contracts:check` — passed; artifacts current.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `RUN_POSTGRES_INTEGRATION=true RUN_S3_INTEGRATION=false pnpm test:coverage` — passed: 54 files, 503 passed, 1 Docker-only S3/MinIO test skipped; 91.74% statements/lines, 86.65% branches, 95.11% functions.
- `pnpm build` — passed.
- `pnpm audit` — passed; no known vulnerabilities.
- `actionlint .github/workflows/ci.yml` — passed.
- `gitleaks git --log-opts=--all --redact --no-banner .` — passed; 83 commits and about 1.13 MB scanned, no leaks.
- `git diff --check` — passed.

## Concern / external production gates

No production deployment, Render mutation, migration, live flag change, paid upgrade, Apple sign-in, TestFlight action, Neon restore point, or object-store operation was performed by this task. The local environment has no Docker executable, so the real MinIO adapter and dual production-image smoke remain mandatory GitHub Actions gates. The physical TestFlight, private-bucket durability, live Apple revocation, same-SHA Render redeploy, and restore drill remain operator-executed production certification gates; the runbooks explicitly prohibit certification without their recorded evidence.
