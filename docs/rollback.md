# Application rollback

Prisma migrations are forward-only during an incident. Do not manually edit `_prisma_migrations` or run ad hoc down SQL.

1. Stop or pause the three cron services to prevent new writes during diagnosis.
2. Select the last known-good Railway deployment and redeploy it.
3. Confirm its required migration is present with `pnpm db:migrate:status`.
4. Require public `/api/v1/health` and `/api/v1/ready` responses of `200`, then exercise the catalog endpoint.
5. Resume cron services from the same known-good commit and inspect their new run events.

Readiness intentionally accepts a database newer than the rolled-back image. If the old application is not schema-compatible, roll forward with a corrective migration or follow the database restore procedure; do not declare success from deployment status alone.
