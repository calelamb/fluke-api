# Scheduled jobs

| Job | GitHub schedule (UTC) | Workflow timeout | Application deadline |
| --- | --- | --- | --- |
| Acartia ingestion | Every six hours at minute 15 | 5 minutes | 2 minutes |
| GBIF ingestion | Sunday 02:15 | 20 minutes | 15 minutes |
| Predictions | Daily 04:00 | 15 minutes | 10 minutes |

`.github/workflows/scheduled-jobs.yml` also accepts a manual dispatch for one job or all jobs. It runs on standard Linux runners with read-only repository permissions. Its three job timeouts cap scheduled runner use at 1,150 minutes in a 30-day month, before early successful exits. GitHub Free includes 2,000 private-repository Actions minutes per month; usage is blocked after the allowance when no valid payment method exists. Check account-wide usage before increasing frequency or timeouts.

The workflow requires these repository secrets:

- `PRODUCTION_DATABASE_URL`: pooled production Postgres connection string.
- `PRODUCTION_DIRECT_URL`: direct production Postgres connection string.
- `SCHEDULED_JOB_JWT_SECRET`: independent random value of at least 32 characters used only to satisfy production configuration validation.

Do not reuse the API signing secret for scheduled jobs. Production feature flags remain explicitly false in the workflow.

All jobs use a PostgreSQL lease, monotonically increasing fence, heartbeat, and append-only run events. Provider writes use `(source, externalId)` upserts; predictions use `(subjectKind, subjectId, horizonHours)` upserts. Re-running a successful job is safe.

Exit codes are `0` for success, `70` for failure or lease loss, `75` when another worker owns the lease, and `78` for invalid configuration. GitHub Actions does not retry a failed job automatically; a retry is an operator decision after the cause is understood.

Run one job locally with:

```bash
pnpm jobs:acartia
pnpm jobs:gbif
pnpm jobs:predictions
```

Before retrying, inspect `job_run_events` for the run ID and safe error code. `SKIPPED_LOCKED` normally means another healthy run is active. `LEASE_LOST` means the worker must be treated as failed even if provider work completed. Never update or delete job events and never delete an active lease to force concurrency; wait for expiry or stop the owning process first.

Synthetic historical sightings are development-only. Production blocks them regardless of flags. Canonical launch data is checked with `pnpm db:verify-seed`.
