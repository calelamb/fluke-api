# Production deployment

## Preconditions

- The exact commit has passed GitHub Actions, including migration status, seed verification, PostgreSQL integration tests, coverage, audit, Gitleaks, image build, and container readiness.
- `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, public origins, and storage settings are configured in Railway. No secret is a build argument.
- A current database backup or provider restore point exists.

## Deploy

1. Deploy the API service with `railway.json`. Its pre-deploy command applies committed Prisma migrations before the new image starts.
2. Require `/api/v1/ready` to return `200`; it verifies database access and this image's required schema.
3. Configure three services from the same commit and environment, selecting `railway.acartia.json`, `railway.gbif.json`, and `railway.predictions.json` as their config files.
4. Run `pnpm db:seed` once, then `pnpm db:verify-seed`. The seed is idempotent and the verifier must report all canonical records.
5. Probe the public `/api/v1/health` and `/api/v1/ready` endpoints and exercise one public catalog request.
6. Inspect the latest job run events after each cron's first execution.

Do not certify a release from Railway state alone. A non-`200` readiness response, unresolved migration, failed seed verification, or failed public probe stops the release.
