# API Task 4 Report: Separate Observer Sessions and CSRF

## Status

DONE

## Scope delivered

- Added a dedicated HS256 observer session contract using `OBSERVER_JWT_SECRET`, issuer `fluke-api`, audience `fluke-ios-observer`, type `observer-session`, role `OBSERVER`, subject user ID, and database-validated `sessionVersion`.
- Added strict application-claim whitelisting so admin or claim-smuggling tokens cannot cross the observer boundary.
- Added `issueObserverSession`, `resolveObserverFromToken`, `resolveOptionalObserver`, and `requireObserver` with a seven-day, host-only, HTTP-only `/api/v1` cookie.
- Added signed double-submit CSRF tokens using independent `OBSERVER_CSRF_SECRET`, 32 random bytes, bounded token/header parsing, and timing-safe cookie/header/signature comparisons.
- Added exact configured web-origin enforcement while preserving native iOS requests that do not send `Origin`.
- Added host-only observer/CSRF cookie clearing at the exact `/api/v1` path. No guessed parent-domain cookie is issued or cleared.
- Added layered admin login throttling at 5 attempts per 15 minutes by both source IP and a SHA-256 key of the trimmed, lowercased account email. The pinned rate-limit library uses a 5,000-entry LRU and resets entries after their window, preventing unbounded memory growth and rotating-IP bypass.
- Bound production proxy trust to exactly one hop and reject unsupported proxy topology values at runtime, so IP throttling cannot accept an arbitrary forwarded chain.
- Restricted `ADMIN_COOKIE_NAME` to bounded RFC cookie-token syntax, rejected collisions with `fluke_observer` and `fluke_csrf`, and rejected prefixes that local non-TLS development cannot honor.
- Preserved the existing canonical 401 behavior and the rule that observer/passwordless rows are rejected before `bcrypt.compare`.
- Preserved Prisma operational failures for the canonical safe 5xx error boundary and structured server logging. The database lookup is keyed only by the JWT subject; email, cookies, and tokens are never sent to the logger.
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
Tests 47 passed (47)
```

Review-fix RED evidence:

```text
- missing observer issuer token resolved instead of rejecting
- Prisma failure was converted to ObserverAuthError 401
- unsafe/colliding admin cookie names parsed successfully
- rotating source IPs bypassed the account-targeted throttle
- unsupported trustProxy=2 reached Fastify instead of failing configuration validation
```

## Verification evidence

```text
pnpm test
Test Files 43 passed | 3 skipped (46)
Tests 356 passed | 13 skipped (369)

pnpm test:coverage
All files: 90.90% statements, 86.04% branches, 93.50% functions, 90.90% lines
src/lib/csrf.ts: 92.15% statements, 85.71% branches, 100% functions
src/lib/observer-auth.ts: 92.36% statements, 89.18% branches, 88.88% functions

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
