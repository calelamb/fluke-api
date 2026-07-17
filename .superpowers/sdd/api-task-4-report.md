# API Task 4 Report: Separate Observer Sessions and CSRF

## Status

DONE

## Scope delivered

- Added a dedicated HS256 observer session contract using `OBSERVER_JWT_SECRET`, audience `fluke-ios-observer`, type `observer-session`, role `OBSERVER`, subject user ID, and database-validated `sessionVersion`.
- Added strict application-claim whitelisting so admin or claim-smuggling tokens cannot cross the observer boundary.
- Added `issueObserverSession`, `resolveObserverFromToken`, `resolveOptionalObserver`, and `requireObserver` with a seven-day, host-only, HTTP-only `/api/v1` cookie.
- Added signed double-submit CSRF tokens using independent `OBSERVER_CSRF_SECRET`, 32 random bytes, bounded token/header parsing, and timing-safe cookie/header/signature comparisons.
- Added exact configured web-origin enforcement while preserving native iOS requests that do not send `Origin`.
- Added host-only observer/CSRF cookie clearing at the exact `/api/v1` path. No guessed parent-domain cookie is issued or cleared.
- Added route-level admin login throttling at 5 attempts per 15 minutes while preserving existing admin login, logout, and `/me` behavior.
- Preserved the existing canonical 401 behavior and the rule that observer/passwordless rows are rejected before `bcrypt.compare`.
- Did not register observer Apple/login/logout/account routes, enable feature flags, add live secrets, or deploy anything; those remain later plan tasks.

## TDD evidence

RED:

```text
pnpm vitest run src/__tests__/observer-auth.test.ts src/__tests__/csrf.test.ts src/__tests__/auth.test.ts
Test Files 3 failed
- observer-auth module missing
- csrf module missing
- admin login rate-limit assertion received 401 instead of 429
```

GREEN:

```text
Test Files 3 passed (3)
Tests 34 passed (34)
```

## Verification evidence

```text
pnpm test
Test Files 43 passed | 3 skipped (46)
Tests 343 passed | 13 skipped (356)

pnpm test:coverage
All files: 90.90% statements, 85.83% branches, 93.80% functions, 90.90% lines
src/lib/csrf.ts: 93.81% statements, 88.00% branches, 100% functions
src/lib/observer-auth.ts: 94.02% statements, 88.88% branches, 100% functions

pnpm typecheck
PASS

pnpm lint
PASS

pnpm build
PASS

pnpm contracts:check
Contract artifacts are current.

pnpm audit
No known vulnerabilities found

git diff --check
PASS
```

The skipped tests are the repository's database-backed integration suites that require an external PostgreSQL test database; no Task 4 test was skipped.

## Environment note

Verification ran under local Node `v25.9.0`; `package.json` requests Node `22.17.0`, so pnpm emitted the existing unsupported-engine warning. Typecheck, build, tests, coverage, lint, contracts, and audit all completed successfully.
