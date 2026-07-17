# API Task 9 Report

Status: DONE_WITH_CONCERNS

## Scope implemented

- Added real PostgreSQL end-to-end coverage for observer sign-in, encrypted refresh-token persistence, authenticated submission, cross-observer Logbook and pending-media isolation, approved-media signed redirects, privacy-preserving account deletion, Apple revocation, object cleanup, and stale-session rejection.
- Added a release security suite that locks all four 80 percent coverage thresholds, ephemeral Apple key generation, pinned private MinIO setup, the complete CI gate set, and the dual Release A / safe Release B smoke matrix.
- Added an opt-in real S3-compatible adapter test that writes, signs, reads, and deletes a private object against the CI MinIO container.
- Added a hardening regression proving that Identify remains canonical 404 and does not reflect supplied credentials or request payloads.
- Fixed the integration seam exposed by the new end-to-end test: media and upload routes now consistently use the injected storage dependency instead of silently constructing a different backend.
- Pinned every third-party GitHub Action to an immutable commit SHA, retained explicit version comments, pinned PostgreSQL and MinIO images, and kept Node at exactly 22.17.0 with pnpm 10.33.0.
- Generated an ephemeral unencrypted PKCS8 EC P-256 Apple key plus independent observer/encryption secrets inside each CI job; no private key or production secret is committed or read from repository secrets.
- Added robust service/container failure logging, bounded readiness loops, forced cleanup traps, Release A and exact safe Release B capability checks, and a mandatory Identify 404 check.
- Added Docker `STOPSIGNAL SIGTERM` and a bounded health check against the non-database liveness endpoint.

## TDD evidence

Initial focused command:

```text
pnpm vitest run tests/observer-security.test.ts
```

Observed RED: 4 expected failures for the missing branch/function/statement thresholds, ephemeral Apple P-256 key generation, pinned private MinIO bucket, and dual release smoke matrix.

The PostgreSQL end-to-end test then failed on the approved-media redirect because the route ignored the injected storage dependency. After threading the dependency through upload, cleanup, and read paths, the focused PostgreSQL and route suites passed.

## Fresh verification

Runtime used for final application gates:

```text
node v22.17.0
pnpm 10.33.0
PostgreSQL 16 temporary local cluster on port 55439
```

Commands and results:

- `pnpm db:generate` — passed.
- `pnpm db:migrate:status` — passed; 10 migrations, schema current.
- `pnpm contracts:check` — passed; generated contracts current.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `RUN_POSTGRES_INTEGRATION=true pnpm test:coverage` — passed: 53 files; 497 passed, 1 skipped; 91.74% statements, 86.63% branches, 95.11% functions, 91.74% lines.
- `pnpm build` — passed.
- `pnpm audit` — passed; no known vulnerabilities.
- `actionlint .github/workflows/ci.yml` — passed with ShellCheck integration.
- `gitleaks git --log-opts=--all --redact --no-banner .` — passed; 81 commits and about 1.10 MB scanned, no leaks.
- Ruby YAML parse and `git diff --check` — passed.

## Concern / remote-only gate

The local workspace has no Docker executable, so the opt-in MinIO adapter test and both production container smokes could not run locally. They are intentionally encoded as required GitHub CI gates using pinned images and immutable action revisions; no production deployment, live bucket, live secret, or production capability flag was touched.
