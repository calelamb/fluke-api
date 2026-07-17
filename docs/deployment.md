# Production deployment

## Supported free topology

- API: Render Free web service at `https://fluke-api.onrender.com`, built from the repository `Dockerfile`.
- Database: Neon Postgres. `DATABASE_URL` is pooled runtime traffic and `DIRECT_URL` is the direct migration connection.
- User media: one private S3-compatible bucket; never the Render filesystem.
- Website: `https://fluke-pnw.vercel.app`.

Render Free can cold-start after inactivity. A cold start is not permission to skip a probe or loosen the client retry bounds. Do not upgrade Render, add a paid service, or add a payment method without an explicit cost decision.

## Release record

Create one release record before changing production. Record:

- the candidate Git SHA and GitHub Actions URL;
- the Render service and deployment IDs;
- the Neon project, branch, database, and database identity;
- the Neon restore point timestamp or branch ID;
- the private bucket and object count, never its credentials;
- the physical TestFlight build number and device model;
- the operator, UTC start time, and each probe result.

Every item below must reference the same Git SHA. Stop if the candidate SHA, GitHub SHA, image SHA, or deployed SHA differs.

## External prerequisite gate

Before touching production, confirm:

- App ID `app.fluke.Fluke` has Sign in with Apple enabled for Team `86RBV2JZ8F`.
- An Apple Sign in with Apple server key exists. Its key ID and unencrypted PKCS8 `.p8` content are held only by the Render secret store.
- `OBSERVER_JWT_SECRET`, `OBSERVER_CSRF_SECRET`, and `APPLE_TOKEN_ENCRYPTION_KEY` were generated independently. Never copy their values into the release record.
- The object bucket is private and its credentials are limited to `GetObject`, `PutObject`, and `DeleteObject` for that bucket.
- The published privacy/support pages and App Store privacy answers describe Apple identifiers, observer email, locations, notes, photos, retention, deletion, and the storage processor.
- The approved-account deletion policy is recorded: pending/rejected records and media are deleted; approved scientific records are retained only after observer identity is irreversibly cleared.

Any missing prerequisite stops the release.

## Same-SHA CI gate

Require the exact same Git SHA to be green in GitHub Actions. The run must include Node 22.17.0, PostgreSQL integration, migration and seed verification, coverage, lint/typecheck/contracts, production audit, full-history Gitleaks, image build, and both all-off and observer-enabled container smoke tests. Do not deploy a local-only build or a newer unverified commit.

## Database gate

1. Create a Neon restore point or protected branch and record its database identity before migration.
2. Against that resolved identity, run the exact candidate image's migration command:

   ```bash
   npm run db:migrate:deploy
   npm run db:migrate:status
   npm run db:verify-seed:runtime
   ```

3. Confirm `20260717170000_add_observer_submissions` and every later committed migration are applied. Migration status and the seed verifier must exit zero.

The production image also exposes an idempotent seed command when canonical seed repair is explicitly required:

```bash
npm run db:seed:runtime
npm run db:verify-seed:runtime
```

Never run these commands until both database URLs have been resolved back to the database identity in the release record.

## Configure secrets while mutations remain off

Configure the complete sets below in Render without exposing their values:

- Apple: `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_TOKEN_ENCRYPTION_KEY`.
- Observer: `OBSERVER_JWT_SECRET`, `OBSERVER_CSRF_SECRET`.
- Private storage: `STORAGE_BACKEND=s3`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`, and `OBJECT_STORAGE_FORCE_PATH_STYLE`.

Keep the production gate exactly all-off:

```text
PRODUCTION_MUTATIONS_ACK=false
ENABLE_ACCOUNTS=false
ENABLE_SUBMISSIONS=false
ENABLE_IDENTIFY=false
```

Partial secret sets, local storage, partial account/submission flags, or Identify enabled must fail startup and stop the release.

## Safe all-off deploy

1. Deploy the exact same-SHA image to Render Free with the all-off flags.
2. Require public `200` responses from `GET /api/v1/health` and `GET /api/v1/ready`.
3. Require `GET /api/v1/capabilities` to return exactly:

   ```json
   {"accounts":false,"identification":false,"submissions":false}
   ```

4. Require the catalog and sighting browse routes to remain healthy.
5. Require observer auth, submission, and Identify routes to remain unregistered.

Any non-`200` health/readiness response, migration error, seed mismatch, capability mismatch, or open mutation route stops the release.

## Enable observer launch state

Change all four values in the same Render configuration operation:

```text
PRODUCTION_MUTATIONS_ACK=true
ENABLE_ACCOUNTS=true
ENABLE_SUBMISSIONS=true
ENABLE_IDENTIFY=false
```

Deploy the unchanged same-SHA image. Require health and readiness `200`, then require `GET /api/v1/capabilities` to return exactly `{"accounts":true,"identification":false,"submissions":true}`. POST /api/v1/identify must return 404 using the canonical error envelope.

Do not open or announce observer access yet. The auth route is intentionally unregistered in the all-off state, so the physical production sign-in gate can occur only after this exact state is live. Any failure from this point requires the all-off rollback.

## Physical TestFlight Apple gate

Immediately use the candidate iOS build on a physical TestFlight device. Complete a fake-free Sign in with Apple against the production API, verify `GET /api/v1/auth/me`, perform `POST /api/v1/auth/logout`, and sign in again. Simulator success, injected tokens, route tests, or an App Store Connect build-processing state do not satisfy this gate. Stop and restore the all-off state on any Apple verification, cookie, CSRF, logout, or re-sign-in failure.

Run every fake-free check in [observer-operations.md](observer-operations.md), including proof that media survives an API redeploy on Render. Record sanitized IDs and pass/fail results, never cookies, tokens, email, request bodies, private keys, or object keys.

Do not certify the release until all checks pass against the same deployed SHA. Immediately follow [rollback.md](rollback.md) on any stop condition.

## Railway alternative

The checked-in `railway*.json` files remain a supported paid topology. Railway is not the current host because the workspace trial expired and a plan would cost money. Do not activate it without an explicit cost decision. If later adopted, its migration and public-probe gates remain identical.
