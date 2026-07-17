# Observer application rollback

This procedure closes observer writes before code changes. Prisma migrations are forward-only during an incident. Never edit `_prisma_migrations`, execute ad hoc down SQL, delete the private bucket, or discard the incident database.

## Close mutations first

1. Record the incident time, deployed SHA, database identity, and private-bucket object count.
2. Set `PRODUCTION_MUTATIONS_ACK=false`.
3. Set `ENABLE_ACCOUNTS=false`.
4. Set `ENABLE_SUBMISSIONS=false`.
5. Keep `ENABLE_IDENTIFY=false`.
6. In one Render operation, redeploy the current exact image with those all-off values.
7. Require `GET /api/v1/health` and `GET /api/v1/ready` to return `200` and capabilities to be exactly `{"accounts":false,"identification":false,"submissions":false}`.
8. Require every disabled observer endpoint below to return 404 while anonymous browse routes remain healthy.

Probe these exact methods and paths after the all-off deployment. Replace `:id` with a fixed non-sensitive sentinel ID; because the route must be unregistered, the chosen ID cannot change the result.

- POST `/api/v1/auth/apple`
- GET `/api/v1/auth/me`
- POST `/api/v1/auth/logout`
- DELETE `/api/v1/auth/account`
- GET `/api/v1/sightings/me`
- POST `/api/v1/sightings`
- POST `/api/v1/sightings/:id/photos`
- GET `/api/v1/media/:photoId`
- POST `/api/v1/identify`

Every response must use the canonical envelope `{"code":"NOT_FOUND","message":"The requested resource was not found.","requestId":"<non-empty>","retryable":false}` with a real non-empty request ID and no reflected cookie, token, email, or payload. Require `GET /api/v1/whales` and `GET /api/v1/sightings` to return `200`. Record methods, sanitized paths, statuses, envelope validation, UTC time, Render source commit/deployment, database identity, and object count.

If the all-off image cannot become ready, keep public traffic closed. Do not re-enable a partial flag combination.

## Preserve state, then revert code

After the all-off probes pass, preserve the database and private object bucket. Do not reverse additive migrations or delete media as part of application rollback. Record their identities and counts for later reconciliation.

Only then redeploy the previous image from the last known-good, same-SHA green GitHub Actions run. Confirm that image supports the current database schema; readiness intentionally permits a database newer than an older image, but a `200` probe is still mandatory.

Require public health/readiness `200`, exact all-off capabilities, closed mutation/auth/Identify routes, and healthy browse routes. Leave observer flags off until the incident is understood and a new complete release passes [deployment.md](deployment.md). Resume scheduled jobs only when their code and schema are proven compatible.

If the previous image is not schema-compatible, roll forward with a reviewed corrective migration or use [restore.md](restore.md). A Render deployment status alone is never rollback certification.
