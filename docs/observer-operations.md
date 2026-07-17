# Observer production certification

Run these checks only after [deployment.md](deployment.md) reaches the observer-enabled, exact same-SHA state. Use real production Apple accounts and a physical TestFlight device. Never paste identity tokens, authorization codes, cookies, CSRF tokens, email addresses, raw request bodies, or private object keys into the release record.

Create two dedicated observer test accounts, Observer A and Observer B. Use unique, recognizable, non-sensitive test metadata and retain only sanitized record IDs and UTC timestamps.

## Baseline and capability firewall

1. Require `GET /api/v1/health` and `GET /api/v1/ready` to return `200`.
2. Require `GET /api/v1/capabilities` to return exactly `{"accounts":true,"identification":false,"submissions":true}`.
3. POST `/api/v1/identify` with a bounded harmless request and require canonical `404`. Any Identify route exposure stops certification.
4. Verify whale and sighting browse routes without an observer cookie.

## Apple session lifecycle

On a physical TestFlight device, Observer A completes real Sign in with Apple. Verify `/api/v1/auth/me`, logout with the app-issued CSRF token, `401` after logout, and successful re-sign-in. Repeat sign-in for Observer B. Any Apple verification or session-lifecycle error stops certification.

## Anonymous and signed submissions

1. Submit one anonymous submission with a new client submission UUID. Record its sanitized sighting ID.
2. Submit one signed submission as Observer A with a different client submission UUID.
3. Simulate response loss without editing the queued request. Perform an exact offline replay with the same UUID and identical payload.
4. Verify the replay returns the original result and creates one database row and one idempotency record. Any duplicate replay row stops certification.
5. Repeat a signed submission as Observer B to establish the isolation fixture.

## Logbook isolation

1. As Observer A, request `GET /api/v1/sightings/me` and require A's signed submission but not B's.
2. As Observer B, require B's signed submission but not A's.
3. Attempt each observer's pending sighting/media identifiers with the other session and require the canonical denial response.

Any cross-user access or identity/email leakage stops certification.

## Private photos and signed media

1. Upload a bounded JPEG to Observer A's pending sighting using a stable photo UUID; exact replay must return the same photo rather than create another row/object.
2. Verify original and thumbnail are private in object storage and are accessible only through the API's authorized signed media flow.
3. Exercise one rejected upload/commit path and confirm compensating cleanup leaves no orphaned object.
4. Record the media response checksum, trigger one no-code-change Render redeploy of the same SHA, then fetch again. The bytes and authorization result must match; this proves media survives an API redeploy.

Any public bucket access, unauthorized signed media, missing variant, duplicate object, storage cleanup failure, or orphaned object stops certification.

## Deletion and Apple revocation

Create a disposable Observer A pending submission/photo, then perform `DELETE /api/v1/auth/account` through the app with valid CSRF. Require Apple authorization revocation to succeed, client cookies/local observer state to clear, subsequent `/auth/me` to return `401`, and pending/rejected data plus media to be deleted. If testing an approved fixture, require the scientific record to remain only with observer identity irreversibly cleared.

Any failed deletion, failed Apple revocation, surviving pending media, restored session, or identity remaining on an approved row stops certification.

## Stop conditions

Stop, switch to the all-off rollback, and do not certify on any:

- non-200 health or readiness response;
- unresolved migration or seed mismatch;
- storage cleanup error, missing object, or orphaned object;
- Apple verification or revocation error;
- capability mismatch or Identify route exposure;
- cross-user access or observer-identity leak;
- duplicate replay row;
- failed deletion or session invalidation;
- media mismatch after the Render redeploy.

Certification requires a sanitized checklist tied to the GitHub run, deployed SHA, Render deployment, Neon database identity/restore point, TestFlight build, and UTC results for every operation above.
