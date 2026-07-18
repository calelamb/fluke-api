# API Task 5 Report: Apple Sign-In and Account Lifecycle Routes

## Scope

Implemented only Task 5 from `docs/superpowers/plans/2026-07-17-observer-submissions-launch.md` on top of `22f4610`.

## Delivered

- Added injected observer account routing for:
  - `POST /api/v1/auth/apple`
  - observer/admin-compatible `GET /api/v1/auth/me`
  - observer-CSRF-protected `POST /api/v1/auth/logout`
  - observer-CSRF-protected `DELETE /api/v1/auth/account`
- Preserved the legacy admin `/me` and `/logout` implementation when observer dependencies are not composed, and preserved its behavior when they are composed.
- Added Apple identity-token verification plus authorization-code exchange orchestration with an explicit subject match before writes.
- Added a 10-attempt-per-source-IP-per-hour Apple sign-in limiter.
- Added transactional observer creation/update with:
  - `OBSERVER` role and nullable password
  - strict verified-email normalization
  - no implicit email-based linking
  - first non-null display-name preservation
  - AES-GCM encrypted refresh-token persistence through the injected cipher
  - session version 1 on creation
- Added observer session/CSRF cookie issuance and fail-closed observer `/me` resolution.
- Added session-version logout invalidation with a compare-and-increment write.
- Added fresh Apple reauthentication for deletion, including identity/code subject matching against the signed-in observer.
- Added Apple revocation before destructive database work for both the stored token and a distinct newly exchanged token.
- Added transactional privacy cleanup:
  - pending/rejected storage-key selection and sighting deletion
  - approved-sighting observer anonymization
  - audit/idempotency cleanup
  - account deletion guarded by Apple subject and the exact revoked refresh-token ciphertext
- Added bounded post-commit storage deletion retries with secret-free structured diagnostics.
- Kept anonymous browsing, admin authorization, identification routing, feature flags, host configuration, keys, and deployment unchanged.

## TDD Evidence

RED was observed before production implementation:

- `src/__tests__/account-deletion.test.ts`: module-not-found for `account-deletion.js`
- `src/__tests__/observer-routes.test.ts`: observer endpoints returned 404
- 14 expected failures total

Final focused run:

```text
Test Files  3 passed (3)
Tests       40 passed (40)
```

Command:

```bash
pnpm vitest run src/__tests__/observer-routes.test.ts src/__tests__/account-deletion.test.ts src/__tests__/auth.test.ts
```

Expanded security/contract run:

```text
Test Files  8 passed (8)
Tests       119 passed (119)
```

Covered observer routes, account deletion, admin auth, observer JWTs, CSRF, Apple verification, token crypto, and public contracts.

Full suite:

```text
Test Files  45 passed | 3 skipped (48)
Tests       374 passed | 13 skipped (387)
```

The skipped suites are opt-in PostgreSQL integration suites. Task 5's plan specifies mocked route/service transaction tests and does not introduce a Task-5-specific PostgreSQL suite; no live database, Apple endpoint, or deployment was invoked.

Coverage:

```text
All files lines: 91.02%
src/routes/observer-auth.ts lines: 89.23%
src/services/account-deletion.ts lines: 98.27%
```

## Static and Supply-Chain Verification

All passed:

```bash
pnpm typecheck
pnpm lint
pnpm contracts:check
pnpm build
pnpm layout:check
pnpm audit
git diff --check
```

`pnpm audit` reported no known vulnerabilities. Contract artifacts were current.

## Constraints / Blockers

- No Task 5 functional blocker.
- The local runtime is Node `v25.9.0`, while the repository pins Node `22.17.0`; pnpm emitted the existing engine warning. All checks above completed successfully.
- Production Apple keys/configuration and composition remain intentionally deferred to Task 8, as specified by the plan. This task adds only the injected route composition seam and does not contact Apple.

## Review Follow-up: Private Cleanup Diagnostics

Commit follow-up removes the private `storageKey` from cleanup-failure logs. The diagnostic boundary now emits only the canonical message plus `requestId`, `failureKind`, and a numeric attempt count bounded to `0...5`. It intentionally does not emit the cleanup error, storage key, a key hash, observer PII, or credentials.

TDD evidence:

- RED: the new logger-spy test failed because the safe diagnostic helper did not exist.
- GREEN: `src/__tests__/observer-routes.test.ts` passed 15/15 and the focused Task 5 set passed 41/41.
- The spy serializes every logger argument and asserts that the private storage key, email, and token-like text are absent while the safe fields remain present.

## Cross-task Launch Gate (Not an API Task 5 Defect)

The current iOS client and the canonical API contract are not yet interoperable. The iOS client sends only `identityToken` and `fullName`, decodes a bare user, assumes non-null email, sends no fresh Apple credential body for deletion, and uses no CSRF response token. Task 5 correctly follows the locked API contract, which requires `authorizationCode` and `nonce`, returns `{ csrfToken, user }`, permits absent Apple email, and requires fresh Apple reauthentication for account deletion. This mismatch must be resolved in the iOS integration task before launch; it was intentionally not papered over in the API.
