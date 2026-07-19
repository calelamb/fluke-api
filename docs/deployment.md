# Production deployment

## Supported free topology

- API: Render Free web service at `https://fluke-api.onrender.com`, built from the repository `Dockerfile`.
- Database: Neon Postgres. `DATABASE_URL` is pooled runtime traffic and `DIRECT_URL` is the direct migration connection.
- User media: one private S3-compatible bucket; never the Render filesystem.
- Website: `https://fluke-pnw.vercel.app`.

Render Free can cold-start after inactivity. A cold start is not permission to skip a probe or loosen the client retry bounds. Do not upgrade Render, add a paid service, or add a payment method without an explicit cost decision.

## Zero-cost gate

Before provisioning, record the current Neon free-plan quota and object-storage free-tier quota from each provider's account page. Record current usage, retention, transfer/request limits, and a conservative launch projection proving projected launch usage remains within both. Require the Render Free service, Neon database, and object store to need no payment method, paid trial, or paid upgrade. Any quota overrun, required card, expiring trial, or non-zero projected charge stops launch for an explicit cost decision.

## Release record

Create one release record before changing production. Record:

- the candidate Git SHA and GitHub Actions URL;
- the Render service/deployment IDs and Render source commit SHA;
- the Render image digest, only if Render exposes one;
- the Neon project, branch, database, and database identity;
- the Neon restore point timestamp or branch ID;
- the private bucket and object count, never its credentials;
- the physical TestFlight build number and device model;
- the operator, UTC start time, and each probe result.

The GitHub Actions commit SHA must equal the Render source commit SHA. The Render image digest is a separate artifact: record it when exposed, but never compare a digest to a Git SHA. Stop if GitHub and Render source commits differ or Render does not identify the source commit.

## External prerequisite gate

Before touching production, confirm:

- App ID `app.fluke.Fluke` has Sign in with Apple enabled for Team `86RBV2JZ8F`.
- An Apple Sign in with Apple server key exists. Its key ID and unencrypted PKCS8 `.p8` content are held only by the Render secret store.
- `OBSERVER_JWT_SECRET`, `OBSERVER_CSRF_SECRET`, and `APPLE_TOKEN_ENCRYPTION_KEY` were generated independently. Never copy their values into the release record.
- The object bucket is private and its credentials are limited to `GetObject`, `PutObject`, and `DeleteObject` for that bucket.
- GET https://fluke-pnw.vercel.app/privacy must return `200` and GET https://fluke-pnw.vercel.app/support must return `200`; record response time, final URL, and UTC result.
- Record the submitted App Store privacy answers and confirm both public pages match these exact categories: Apple account identifier, observer email, submitted coarse location, notes and photos, retention and deletion, and the private object-storage processor. Record that these data support App Functionality, that signed-account data can be linked to the observer, and that Fluke does not use the data for tracking or third-party advertising. Any missing/mismatched answer, disclosure, or redirect/error response stops launch.
- The approved-account deletion policy is recorded: pending/rejected records and media are deleted; approved scientific records are retained only after observer identity is irreversibly cleared.

Any missing prerequisite stops the release.

## Same-SHA CI gate

Require the candidate commit to be green in GitHub Actions. The run must include Node 22.17.0, PostgreSQL integration, migration and seed verification, coverage, lint/typecheck/contracts, production audit, full-history Gitleaks, image build, and all-off, observer-enabled, and on-device container smoke tests. Render must then report that exact commit as its source revision. Do not deploy a local-only build or a newer unverified commit.

## Database gate

1. Create a Neon restore point or protected branch and record its database identity before migration.
2. Confirm the same-SHA container smoke started each candidate image against a blank PostgreSQL database and reached `/api/v1/ready` without a separate migration step.
3. Use the exact candidate image during the safe all-off deploy below. The image entrypoint runs `prisma migrate deploy` before starting Node; a migration failure exits the container before the API can listen.
4. Inspect the Render startup log and confirm Prisma reports `20260717170000_add_observer_submissions` and every later committed migration applied or already current. Then require `/api/v1/ready` to return `200`, which verifies the required migration marker and database probe before launch continues.

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
IDENTIFIER_MODE=disabled
```

Remove the legacy `ENABLE_IDENTIFY` variable before setting `IDENTIFIER_MODE`; conflicting dual configuration fails startup. An older deployment with no `IDENTIFIER_MODE` remains compatible: `ENABLE_IDENTIFY=true` maps to `server`, while false or absent maps to `disabled`. Partial secret sets, local storage, partial account/submission flags, or production server inference must fail startup and stop the release.

## Safe all-off deploy

1. Deploy Render's build from the verified source commit with the all-off flags.
2. Require public `200` responses from `GET /api/v1/health` and `GET /api/v1/ready`.
3. Require `GET /api/v1/capabilities` to return exactly:

   ```json
   {"accounts":false,"identification":false,"identificationMode":"disabled","submissions":false}
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
IDENTIFIER_MODE=disabled
```

Deploy the unchanged Render source commit. Require health and readiness `200`, then require `GET /api/v1/capabilities` to return exactly `{"accounts":true,"identification":false,"identificationMode":"disabled","submissions":true}`. POST /api/v1/identify must return 404 using the canonical error envelope.

Do not open or announce observer access yet. The auth route is intentionally unregistered in the all-off state, so the physical production sign-in gate can occur only after this exact state is live. Any failure from this point requires the all-off rollback.

## Physical TestFlight Apple gate

Immediately use the candidate iOS build on a physical TestFlight device. Complete a fake-free Sign in with Apple against the production API, verify `GET /api/v1/auth/me`, perform `POST /api/v1/auth/logout`, and sign in again. Simulator success, injected tokens, route tests, or an App Store Connect build-processing state do not satisfy this gate. Stop and restore the all-off state on any Apple verification, cookie, CSRF, logout, or re-sign-in failure.

Run every fake-free check in [observer-operations.md](observer-operations.md), including proof that media survives an API redeploy on Render. Record sanitized IDs and pass/fail results, never cookies, tokens, email, request bodies, private keys, or object keys.

## Accept the certified identifier release

Keep `IDENTIFIER_MODE=disabled` while preparing the on-device release. Run the external verifier against the exact model, index, manifest, rights digest, and catalog inventory shipped in the same candidate mobile build. The verifier must produce immutable evidence with `ready:true`; any missing catalog member, version mismatch, rights failure, or non-ready result stops the release.

After recording that external verifier evidence, an administrator may accept the immutable release through the reviewed admin endpoint. Acceptance creates exactly one status `ACTIVE` release; `ACCEPTED` means superseded and is not readiness evidence. Confirm directly against the recorded production database identity that exactly one release is `ACTIVE`. Do not add or infer a second persisted readiness flag.

## Enable on-device identification

Set `IDENTIFIER_MODE=on-device` and redeploy the unchanged Render source commit. Never set `IDENTIFIER_MODE=server` in production. The API readiness check now requires the existing migration/database probe, exactly one `ACTIVE` identifier release, a healthy public-feed dependency, and a healthy submission dependency.

Require all of these same-SHA probes before opening identification:

1. `GET /api/v1/health` and `GET /api/v1/ready` return `200`.
2. `GET /api/v1/capabilities` returns exactly `{"accounts":true,"identification":true,"identificationMode":"on-device","submissions":true}`.
3. `GET /api/v1/identifier/releases/current` returns `200` metadata matching the externally verified manifest, model, and index versions.
4. `GET /api/v1/sighting-feed` returns `200` with its strict public envelope.
5. `POST /api/v1/sightings` completes one bounded, idempotent TestFlight submission carrying valid local-identification evidence, then an exact replay returns the same sighting and suggestion IDs.
6. `POST /api/v1/identify` must return 404 using the canonical error envelope.

Any `503`, missing/mismatched release, feed failure, submission failure, duplicate replay, capability mismatch, or server Identify exposure requires the all-off rollback. Record the GitHub SHA, Render source SHA, release manifest, sanitized response IDs, and UTC probe results.

## Mandatory rollback drill

Before certification, complete one successful-path rollback drill using the current verified commit:

1. Follow **Close mutations first** in [rollback.md](rollback.md) without reverting code.
2. Require `GET /api/v1/capabilities` to return exactly `{"accounts":false,"identification":false,"identificationMode":"disabled","submissions":false}`.
3. Run every exact method/path probe in the rollback runbook and require the canonical `404` envelope for auth, mutation, media, and Identify routes while the listed healthy browse routes return `200`.
4. Record the rollback drill evidence: GitHub commit, Render source commit/deployment, UTC flag change, every status/envelope, browse result, and database/object counts.
5. Confirm the rollback preserved the previously certified sole `ACTIVE` release, then perform a controlled same-commit re-enable by repeating **Enable observer launch state**, the physical TestFlight Apple gate, **Enable on-device identification**, and all checks in [observer-operations.md](observer-operations.md). Do not register or accept the same release a second time. Require the exact enabled capability JSON and Identify `404` again.

Do not certify the release until the original launch checks and this close/reopen drill pass against the same Git commit. Immediately restore all-off and investigate on any stop condition.

## Railway alternative

The checked-in `railway*.json` files remain a supported paid topology. Railway is not the current host because the workspace trial expired and a plan would cost money. Do not activate it without an explicit cost decision. If later adopted, its migration and public-probe gates remain identical.
