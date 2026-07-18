# PostgreSQL job lease precision fix

## Scope

Fix immediate job-lease release and reacquisition only. No deployment, push, workflow, environment, schema, or live-service changes were made.

## Root cause

`job_leases.lease_expires_at` is `TIMESTAMP(3)`, but `release()` previously assigned the finer-precision `CURRENT_TIMESTAMP`. PostgreSQL can round that value forward when storing it. An immediately following ownership check could therefore still see the released lease as live, and an immediate `acquire()` could return `null`.

The pre-fix PostgreSQL test reproduced both unsafe outcomes: a released owner could still execute `runFenced`, and a replacement owner could be denied.

## TDD evidence

RED:

- Unit SQL contract failed because `release()` did not place the expiry before database time.
- Fresh PostgreSQL 16 integration failed in the new immediate-reacquisition loop with `promise resolved "stale write" instead of rejecting`.
- The original integration test also reproduced intermittently in 3 runs before the deterministic regression was added.

GREEN:

- `release()` now stores `CURRENT_TIMESTAMP - INTERVAL '1 millisecond'`, one full column precision unit in the past.
- Focused unit and PostgreSQL tests: 11 passed.
- PostgreSQL integration repeated 20 times: all passed; each run performed 50 immediate release, stale-write rejection, and reacquisition cycles.

## Fencing and security review

- Release still matches the exact immutable `job_name`, `run_id`, `owner_token`, and `fence` tuple.
- The lease row is retained, so reacquisition increments the existing monotonic fence.
- A stale release cannot expire a replacement lease because the replacement has a new run, owner, and fence.
- A released owner fails the existing `lease_expires_at > CURRENT_TIMESTAMP` fencing predicate immediately.
- No input surface, credentials, authorization, SQL interpolation pattern, or audit-event behavior changed.

## Verification

All commands used Node `v22.17.0` and pnpm `10.33.0`.

- Fresh PostgreSQL 16 migrations: 10 applied; schema current.
- Full suite with PostgreSQL enabled and explicit test origin: 54 files passed; 514 tests passed; 1 S3 integration test skipped because local Docker/MinIO is unavailable.
- Coverage: 91.74% statements/lines, 86.65% branches, 95.11% functions.
- `pnpm ci:env:check`: passed.
- `pnpm layout:check`: passed.
- `pnpm contracts:check`: passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm build`: passed.
- `pnpm audit`: no known vulnerabilities.
- `actionlint`: passed.
- Gitleaks 8.30.1 full-history scan: no leaks found across 86 commits.
- `git diff --check`: passed.

## Separate release blocker discovered

The exact checked-in CI fixture currently fails the unrelated CSRF test before this change: `.github/ci-test.env` sets `WEB_ORIGIN=http://localhost:5174`, while `src/__tests__/csrf.test.ts` hardcodes `http://localhost:5173` although the test says it accepts the configured origin. With the fixture unchanged, the full run produced 514 passes and one CSRF failure. The successful full verification above explicitly used `WEB_ORIGIN=http://localhost:5173` as a diagnostic override. Per scope, this separate CI fixture collision was reported to the parent and not modified in this commit.
