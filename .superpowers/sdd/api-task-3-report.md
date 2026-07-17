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

## Implemented

- Exact Apple identity-token issuer, native audience, RS256 algorithm, expiration, nonce, and non-empty subject verification.
- Bounded remote Apple JWKS resolver with a 5-second request timeout, 30-second cooldown, and 10-minute in-memory cache lifetime.
- Constructor-injected JWKS, fetch implementation, and clock so tests never reach Apple.
- ES256 Apple client-secret JWT with exact team issuer, native client-id subject, Apple audience, key id, and 180-day maximum lifetime.
- Bounded authorization-code exchange and refresh-token revocation using form-encoded Apple endpoints.
- Verified token-endpoint identity token and optional mandatory subject comparison at the account-creation call seam.
- Stable sanitized errors that never include authorization codes, identity tokens, refresh tokens, upstream bodies, or private-key contents.
- AES-256-GCM token encryption with a random 12-byte IV, 16-byte authentication tag, authenticated version byte, and canonical `1.iv.tag.ciphertext` base64url envelope.
- Strict 32-byte canonical base64url encryption-key decoder and fail-closed envelope, tag, key, and version validation.

## Verification

- `pnpm vitest run src/__tests__/apple-auth.test.ts src/__tests__/token-crypto.test.ts`: 23 passed, 0 failed.
- Focused coverage: `apple-auth.ts` 92.61% lines; `token-crypto.ts` 97.05% lines.
- `pnpm test`: 307 passed, 13 PostgreSQL-gated tests skipped, 0 failed.
- `pnpm test:coverage`: 90.8% repository lines, 85.46% branches, 93.17% functions.
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

Planned commit message: `feat: verify Apple identity credentials`.
