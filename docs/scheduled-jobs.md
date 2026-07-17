# Scheduled jobs

| Job | Railway config | Schedule (UTC) | Deadline |
| --- | --- | --- | --- |
| Acartia ingestion | `railway.acartia.json` | Every six hours at minute 15 | 2 minutes |
| GBIF ingestion | `railway.gbif.json` | Sunday 02:15 | 15 minutes |
| Predictions | `railway.predictions.json` | Daily 04:00 | 10 minutes |

All jobs use a PostgreSQL lease, monotonically increasing fence, heartbeat, and append-only run events. Provider writes use `(source, externalId)` upserts; predictions use `(subjectKind, subjectId, horizonHours)` upserts. Re-running a successful job is safe.

Exit codes are `0` for success, `70` for failure or lease loss, `75` when another worker owns the lease, and `78` for invalid configuration. Railway restart policy is `NEVER`; retries are operator decisions after the cause is understood.

Run a one-off from the production image with exactly one of:

```bash
npm run jobs:acartia:runtime
npm run jobs:gbif:runtime
npm run jobs:predictions:runtime
```

Before retrying, inspect `job_run_events` for the run ID and safe error code. `SKIPPED_LOCKED` normally means another healthy run is active. `LEASE_LOST` means the worker must be treated as failed even if provider work completed. Never update or delete job events and never delete an active lease to force concurrency; wait for expiry or stop the owning service first.

Synthetic historical sightings are development-only. Production blocks them regardless of flags. Canonical launch data is checked with `npm run db:verify-seed:runtime`.
