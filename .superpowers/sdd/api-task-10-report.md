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

## Review remediation

Independent review blocked the initial runbooks on six Important and two Minor gaps. All eight are now represented by behavior-focused release-config regressions and remediated:

- Production certification now requires a successful all-off rollback drill, exact closed-route envelopes and healthy browse evidence, followed by a controlled re-enable of the unchanged Render source commit through the physical TestFlight and observer gates.
- Restore uses a bounded transactional `sessionVersion` update beyond the recorded incident maximum, a zero-row direct verifier, and a temporary isolated non-public enabled verifier for stale-cookie `401` proof while production remains all-off.
- Same-code evidence now compares the GitHub Actions commit SHA with Render's source commit SHA. A Render image digest is recorded separately when exposed and is never conflated with a Git SHA.
- Deletion/revocation certification begins with a fresh physical-device Apple authorization code, identity token, and nonce; it requires verified subject continuity, token exchange, and Apple revocation.
- Production no longer injects a storage/database failure. Compensation evidence comes from the exact-commit CI injected failure test, while production verifies a normal disposable upload with before/after database and object inventories.
- The prerequisite gate requires exact `200` probes for the public privacy and support pages plus recorded App Store privacy-answer content.
- The zero-cost gate records current Neon and object-store free quotas, projected launch usage, and requires no card, paid trial, or paid upgrade.
- Rollback lists every disabled observer method/path, the exact canonical `NOT_FOUND` envelope, healthy browse probes, and the evidence record.

Remediation TDD evidence:

- RED: `pnpm vitest run tests/release-config.test.ts` produced exactly 8 expected failures for the eight review gaps.
- GREEN: the same focused suite passed 29/29 after remediation.

Fresh post-remediation verification used Node v22.17.0, pnpm 10.33.0, and a clean PostgreSQL 16 database on port 55443:

- All 10 migrations applied and status was current.
- Layout, contracts, typecheck, lint, build, production audit, actionlint, Gitleaks, and diff checks passed.
- Real PostgreSQL coverage passed: 54 files; 511 passed, 1 Docker-only MinIO test skipped; 91.74% statements/lines, 86.67% branches, 95.11% functions.

## Second review remediation

The second review identified one remaining Important deletion-proof ambiguity and one Minor restore overflow gap. Both were reproduced first as exactly two failing release-config tests, then remediated:

- Deletion certification now requires two distinct physical Apple authorizations. Authorization A is sent once to `POST /api/v1/auth/apple` to establish the session and stored refresh token. Authorization B is unused until its code/token/nonce are sent in the DELETE body, where its code is exchanged exactly once. The runbook requires revocation of both the stored and newly exchanged reauthentication refresh credentials before database deletion, matching `account-deletion.ts`.
- Restore now queries and records the current restored observer maximum, bounds both restored and incident maxima to `1...2147483646`, rechecks the actual maximum under the table lock inside the transaction, and stops/escalates instead of incrementing when the restored maximum is `2147483647`.

Fresh focused verification passed 31/31. The proportionate non-PostgreSQL full gate passed 495 tests with 19 opt-in integration skips and retained 91.18% statements/lines, 85.54% branches, and 94.78% functions; layout, contracts, typecheck, lint, build, audit, and diff checks passed.

The attempted all-PostgreSQL gate passed the Task 10 contract and observer submission tests but exposed an unrelated, reproducible scheduled-job test failure: an immediate lease reacquire can return null after release because `job_leases.lease_expires_at` is `TIMESTAMP(3)` while `CURRENT_TIMESTAMP` has finer precision and can round the stored release time forward. This docs-only remediation did not alter that out-of-scope job-lease implementation; it should be handled as a separate product fix.
