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

A restore can lower a user's `sessionVersion` and accidentally match an old signed cookie. Before reopening, invalidate all restored observer sessions by advancing every retained observer's `sessionVersion` beyond both the restored and incident-era values, then verify no restored observer session becomes valid. Test old cookies against `GET /api/v1/auth/me` and require `401` without logging cookie contents.

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

Record the Neon restore point, old and new database identities, image SHA, migration output, object counts, session invalidation evidence, rotations, affected rows, and final probe results. A restored database alone is not production certification.
