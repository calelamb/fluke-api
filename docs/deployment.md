# Production deployment

## Current Release A topology

- API: Render Free web service at `https://fluke-api.onrender.com`, built from the repository `Dockerfile` on `main`.
- Database: external Neon Postgres using pooled `DATABASE_URL` for runtime traffic and direct `DIRECT_URL` for migrations.
- Scheduled ingestion and prediction jobs: `.github/workflows/scheduled-jobs.yml` on standard GitHub-hosted Linux runners.
- Website origin: `https://fluke-pnw.vercel.app`.

The free Render instance spins down after inactivity, so the first request can be delayed. Release A clients must retain their bounded stale/offline cache behavior. Do not upgrade the instance or add a payment method without an explicit cost decision.

## Preconditions

- The exact commit has passed GitHub Actions, including migration status, seed verification, PostgreSQL integration tests, coverage, audit, Gitleaks, image build, and container readiness.
- `DATABASE_URL`, `DIRECT_URL`, a fresh `JWT_SECRET`, public origins, feature firewalls, and storage settings are configured in the host. No secret is a build argument.
- A current database restore point exists.
- The production database reports all committed migrations applied and `pnpm db:verify-seed` reports the canonical records.

## Deploy and certify

1. Apply committed migrations with `pnpm db:migrate:deploy` using the approved direct database URL.
2. Verify migrations with `pnpm db:migrate:status`, then run `pnpm db:verify-seed`.
3. Deploy the exact green `main` commit to the Render Free service using the repository `Dockerfile`.
4. Wait for the deployment revision with the current environment to become live.
5. Require public `200` responses from `/api/v1/health` and `/api/v1/ready`.
6. Require `/api/v1/capabilities` to report accounts, identification, and submissions as `false` for Release A.
7. Exercise bounded whale and sighting catalog requests and verify the production web origin receives the expected CORS header.
8. Confirm submission, identification, and account endpoints fail closed while their Release A flags are disabled.
9. Run each scheduled job manually once after configuring its repository secrets, then inspect its append-only job events.

When operating from the pruned production image, the equivalent canonical seed checks are available without development dependencies:

```bash
npm run db:seed:runtime
npm run db:verify-seed:runtime
```

The seed is idempotent. Run it only against the resolved production target and require the verifier to succeed before certification.

Do not certify a release from host state alone. A non-`200` readiness response, unresolved migration, failed seed verification, open Release B capability, failed public probe, or failed scheduled job stops the release.

## Railway alternative

The checked-in `railway*.json` files remain a supported paid deployment topology. Railway is not the current host because the authenticated workspace trial is expired and requires a paid plan. If Railway is adopted later, its pre-deploy migration and readiness requirements remain mandatory; a Railway deployment marked successful is never sufficient without the public probes above.
