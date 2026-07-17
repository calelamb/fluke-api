# Database restore

Use the PostgreSQL provider's point-in-time recovery or backup restore facility. Practice this procedure in a non-production project before launch.

1. Put the API in maintenance mode and stop all cron services so no writer targets the damaged database.
2. Restore to a new database or provider branch at a timestamp before the incident. Preserve the original database for investigation.
3. Point a one-off verification environment at the restored database and run `pnpm db:migrate:status`, `pnpm db:migrate:deploy`, and `pnpm db:verify-seed`.
4. Start the candidate API and require `/api/v1/health` and `/api/v1/ready` to return `200`. Verify catalog counts and the most recent legitimate sighting and job event timestamps.
5. Atomically update `DATABASE_URL` and `DIRECT_URL` for the API and all cron services. Redeploy the same known-good commit.
6. Probe public health, readiness, and catalog behavior before reopening traffic; then resume crons one at a time.

Record the restore point, affected rows, verification output, and final database identity. Rotate database credentials if compromise rather than operator error caused the restore.
