# Database and media restore

Practice this procedure in a non-production Neon project before launch. Restore into a new branch/database, preserve the original for investigation, and keep observer capabilities all-off until reconciliation is complete.

## Contain and identify

1. Complete the all-off phase in [rollback.md](rollback.md) and stop every scheduled writer.
2. Record the incident window, current Git SHA, Neon project/branch/database, resolved database identity, private bucket, and object inventory. Never record credentials or private object keys in a public ticket.
3. Select a Neon restore point before the incident. Restore it to a new branch or database; do not overwrite the source database.

## Validate the restored candidate

1. Point a one-off process using the selected same-SHA production image at the restored `DATABASE_URL` and `DIRECT_URL`.
2. Run:

   ```bash
   npm run db:migrate:status
   npm run db:migrate:deploy
   npm run db:verify-seed:runtime
   ```

3. Require `20260717170000_add_observer_submissions` and every later migration needed by that image.
4. Start an isolated candidate API with all capability flags false. Require `/api/v1/health` and `/api/v1/ready` to return `200` and verify catalog counts plus the last legitimate sighting/job timestamps.

## Reconcile database and media

Export a sanitized database photo manifest and a private object inventory. Perform two-way reconciliation:

- every database photo variant must have exactly one expected private object;
- every object must belong to a retained database photo variant;
- pending/rejected records removed by account deletion must not regain objects;
- approved anonymized records must not regain observer identity;
- suspected orphan or missing objects remain quarantined for investigation, not silently deleted or invented.

Record counts and discrepancies. A mismatch stops reopening. Repair only from a verified source and repeat reconciliation.

## Reconcile observer sessions and keys

A restore can lower a user's `sessionVersion` and accidentally match an old signed cookie. Keep the production service all-off. From incident evidence, calculate `:incidentMaxSessionVersion` as the maximum observer session version that could have signed a cookie before containment. Query the restored database before mutation:

```sql
SELECT MAX("session_version") AS "restoredMaxSessionVersion"
FROM "users"
WHERE "role" = 'OBSERVER';
```

Treat a null result (no restored observers) as `1`. Independently verify both `:incidentMaxSessionVersion BETWEEN 1 AND 2147483646` and `:restoredMaxSessionVersion BETWEEN 1 AND 2147483646`; the upper bound leaves room for one invalidating increment. If the current restored maximum is `2147483647`, or either value is outside its bound, stop and escalate to a separately reviewed schema/session-revocation procedure. Do not run the increment.

Run this bounded transactional update through a reviewed database client with bind-variable support. `ON_ERROR_STOP` (or the client's equivalent) is mandatory so a check, lock, overflow, or update failure rolls back the transaction:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE "session_restore_bound" (
  "incident_max" integer NOT NULL CHECK ("incident_max" BETWEEN 1 AND 2147483646),
  "restored_max" integer NOT NULL CHECK ("restored_max" BETWEEN 1 AND 2147483646),
  "actual_restored_max" integer NOT NULL CHECK ("actual_restored_max" BETWEEN 1 AND 2147483646),
  CHECK ("actual_restored_max" = "restored_max")
) ON COMMIT DROP;
LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO "session_restore_bound" ("incident_max", "restored_max", "actual_restored_max")
SELECT
  :incidentMaxSessionVersion,
  :restoredMaxSessionVersion,
  COALESCE(MAX("session_version"), 1)
FROM "users"
WHERE "role" = 'OBSERVER';
UPDATE "users"
SET "session_version" = GREATEST("session_version", :incidentMaxSessionVersion) + 1
WHERE "role" = 'OBSERVER';
COMMIT;
```

Record the affected observer count and the post-update minimum/maximum, not identities. A direct verifier must return zero:

```sql
SELECT COUNT(*) AS "sessions_not_invalidated"
FROM "users"
WHERE "role" = 'OBSERVER'
  AND "session_version" <= :incidentMaxSessionVersion;
```

The public all-off API correctly returns `404` for the absent auth route, so it cannot prove stale-cookie rejection. Start an isolated non-public verifier from the matching Render source commit, connected to the restored candidate database with complete production dependencies and exactly `PRODUCTION_MUTATIONS_ACK=true`, `ENABLE_ACCOUNTS=true`, `ENABLE_SUBMISSIONS=true`, and `IDENTIFIER_MODE=disabled`, with the legacy `ENABLE_IDENTIFY` variable absent, but with no public ingress, DNS, or scheduled writers. Submit representative pre-incident cookies to `GET /api/v1/auth/me` and require canonical `401`; record only request IDs/statuses, then destroy the verifier. Together with the zero-row direct query, this verifies no restored observer session becomes valid. The production service remains all-off throughout. Any `200`, database mismatch, public exposure, or non-canonical response stops restoration.

After suspected compromise, rotate all affected values before traffic returns:

- `OBSERVER_JWT_SECRET` and `OBSERVER_CSRF_SECRET`;
- `APPLE_TOKEN_ENCRYPTION_KEY` and affected Apple server credentials;
- database and object-storage credentials;
- any admin/session credentials in the incident scope.

Rotation must not silently make encrypted Apple refresh tokens unrecoverable. Revoke Apple authorization where possible, clear unusable ciphertext through a reviewed reconciliation, and require the affected observer to sign in again. Never restore a compromised secret from backup.

## Cut over and certify

1. Atomically update the API and every job to the new database identity while capability flags remain all-off.
2. Deploy the same known-good image and require public health/readiness `200`, exact all-off capabilities, healthy browse routes, and closed auth/mutation/Identify routes.
3. Recount database rows and object inventory and repeat reconciliation.
4. Resume scheduled jobs one at a time and inspect their append-only events.
5. Re-enable observer capabilities only by running the complete same-SHA process in [deployment.md](deployment.md).

Record the Neon restore point, old/new database identities, GitHub and Render source commits, Render image digest when exposed, migration output, object counts, session invalidation evidence, rotations, affected rows, and final probe results. A restored database alone is not production certification.
