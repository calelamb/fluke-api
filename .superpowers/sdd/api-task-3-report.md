# API Task 3 Report: Apple Credentials and Refresh-Token Encryption

## Scope

Implemented only plan Task 3 from `docs/superpowers/plans/2026-07-17-observer-submissions-launch.md`.
No live Apple request, Apple key creation, feature-flag change, deployment, route wiring, or production-environment change was performed.

## Research and TDD Evidence

- Reviewed the repository TypeScript rules and existing bounded-provider/error patterns.
- Searched GitHub code for existing TypeScript Apple OAuth implementations before implementation.
- Added the pinned `jose@6.1.0` dependency.
- RED: `pnpm vitest run src/__tests__/apple-auth.test.ts src/__tests__/token-crypto.test.ts` failed because `src/services/apple-auth.ts` and `src/lib/token-crypto.ts` did not exist.
- GREEN: the same focused command passed 23/23 tests after implementation.
- Review-fix RED: 9/34 focused cases failed after adding subject-binding, strict-claim-shape, redirect, standard-base64, response-bound, and whitespace-token regressions.
- Review-fix GREEN: the expanded focused suite passed 37/37 cases.

## Implemented

- Exact Apple identity-token issuer, scalar native audience, RS256 algorithm, required numeric expiration, nonce, and non-empty subject verification.
- Bounded non-empty key id validation before invoking the resolver; array audiences, missing/invalid expiration, and malformed key ids fail closed.
- Bounded remote Apple JWKS resolver with a 5-second request timeout, 30-second cooldown, 10-minute in-memory cache lifetime, and 128 KiB response ceiling before JOSE parses JSON.
- Constructor-injected JWKS, fetch implementation, and clock so tests never reach Apple.
- ES256 Apple client-secret JWT with exact team issuer, native client-id subject, Apple audience, key id, and 180-day maximum lifetime.
- Bounded authorization-code exchange and refresh-token revocation using form-encoded fixed Apple endpoints with redirects disabled.
- Token endpoint JSON is limited to 64 KiB before parsing.
- Verified token-endpoint identity token and required subject comparison at the account-creation call seam; the comparison cannot be omitted.
- Stable sanitized errors that never include authorization codes, identity tokens, refresh tokens, upstream bodies, or private-key contents.
- AES-256-GCM token encryption with a random 12-byte IV, 16-byte authentication tag, authenticated version byte, and canonical `1.iv.tag.ciphertext` base64url envelope.
- Strict 32-byte canonical padded standard-base64 encryption-key decoder matching `openssl rand -base64 32`, plus fail-closed envelope, whitespace-only plaintext, tag, key, and version validation.

## Verification

- `pnpm vitest run src/__tests__/apple-auth.test.ts src/__tests__/token-crypto.test.ts`: 37 passed, 0 failed.
- Focused coverage: `apple-auth.ts` 90.51% lines and 85.52% branches; `token-crypto.ts` 97.36% lines and 86.66% branches.
- `pnpm test`: 321 passed, 13 PostgreSQL-gated tests skipped, 0 failed.
- `pnpm test:coverage`: 90.73% repository lines, 85.68% branches, 93.26% functions.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm build`: passed.
- `pnpm audit --prod --audit-level=high`: no known vulnerabilities.
- `git diff --check`: passed.

## External Blockers and Boundaries

- Live Apple exchange, JWKS, and revocation are intentionally unverified because this task forbids live Apple calls and no Apple service key was created or supplied.
- Host-level Apple configuration and encryption-key environment validation remain Task 8 composition work by plan; this task validates constructor inputs and supplies the exact 32-byte key decoder.
- PostgreSQL-gated suites remain skipped unless their explicit integration environment is supplied; Task 3 does not use the database.
- Verification ran on local Node `v25.9.0`; the project pins Node `22.17.0`, so pnpm emitted the existing engine warning. Typecheck, build, tests, coverage, lint, and audit all passed.

## Commit

Initial commit: `5d1a545 feat: verify Apple identity credentials`.

Planned review-fix commit message: `fix: close Apple credential review gaps`.
