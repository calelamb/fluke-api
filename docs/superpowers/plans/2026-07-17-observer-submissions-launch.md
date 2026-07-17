# Observer Accounts and Submissions Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely enable Sign in with Apple, observer sessions, idempotent sighting submissions, durable photo uploads, Logbook, and account deletion in production while keeping photo identification disabled and fail-closed.

**Architecture:** Apple credentials are verified and exchanged by a focused service; observer sessions use a dedicated cookie contract, explicit JWT audience, database-backed session version, and double-submit CSRF protection that cannot be confused with admin authentication. Sighting writes are idempotent and observer-scoped, media is stored in a private S3-compatible bucket with compensating cleanup, and production startup admits only the exact `{accounts:true, submissions:true, identification:false}` launch state after all required secrets are validated.

**Tech Stack:** Node.js 22.17.0, TypeScript 5.7, Fastify 5, Zod 3.24, Prisma 5.22/PostgreSQL 16, `jose`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, Sharp, Vitest 3.2, Docker, GitHub Actions, Render Free, Neon Postgres.

## Global Constraints

- Use test-driven development for every behavior: write one focused failing test, run it and observe the expected failure, implement the minimum behavior, rerun it, then refactor.
- Preserve the canonical `SafeErrorSchema` envelope for every HTTP error; never return Apple, JWT, database, storage, or image-decoder diagnostics to clients.
- Keep `ENABLE_IDENTIFY=false` in every production process; `POST /api/v1/identify` must remain unregistered and return canonical 404.
- Production mutation state is exactly all-off or accounts-plus-submissions: partial production combinations must fail startup.
- Preserve anonymous browsing and anonymous metadata submission; a present but invalid observer cookie must fail 401 rather than silently downgrade to anonymous.
- Do not log identity tokens, authorization codes, refresh tokens, session cookies, CSRF tokens, private object keys, email addresses, or raw request bodies.
- Keep functions under 50 lines, files under 800 lines, and use immutable return values and focused modules.
- Maintain at least 80 percent line, branch, function, and statement coverage.
- Never use Render's ephemeral local filesystem for production user media.
- Do not enable production flags until the exact green Git commit has been deployed, migrations are applied, external prerequisites are present, and every production gate in Task 10 passes.

## External Prerequisites

The implementation can be completed and tested with injected fakes before these inputs exist, but production enablement cannot proceed without all of them:

1. Apple App ID `app.fluke.Fluke` must have Sign in with Apple enabled under Team ID `86RBV2JZ8F`.
2. Apple must provide a Sign in with Apple server key ID and its `.p8` private key. Store them only as `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` host secrets; preserve PEM newlines in the secret value.
3. Generate independent 32-byte random values for `OBSERVER_JWT_SECRET`, `OBSERVER_CSRF_SECRET`, and `APPLE_TOKEN_ENCRYPTION_KEY`. The encryption key is base64-encoded raw 32-byte AES-256 key material.
4. Provision one private S3-compatible bucket and credentials with `GetObject`, `PutObject`, and `DeleteObject` limited to that bucket. Provide `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`, and `OBJECT_STORAGE_FORCE_PATH_STYLE`.
5. Approve this deletion policy: pending and rejected sightings and their media are deleted; approved sightings are retained as public scientific records only after `observerName`, `observerEmail`, and `observerUserId` are irreversibly cleared.
6. Update the published privacy policy and App Store privacy answers to cover Apple account identifiers, observer email, submitted locations/notes/photos, retention, account deletion, and the object-storage processor before production flags are enabled.

---

## File Structure

### New focused modules

- `src/contracts/auth.ts` — Apple exchange, authenticated-user, CSRF, and deletion schemas.
- `src/services/apple-auth.ts` — Apple JWKS verification, authorization-code exchange, refresh-token revocation, and client-secret generation.
- `src/lib/token-crypto.ts` — AES-256-GCM encryption/decryption for Apple refresh tokens.
- `src/lib/observer-auth.ts` — observer cookie claims, database-backed session validation, and optional-observer resolution.
- `src/lib/csrf.ts` — double-submit CSRF token issue and verification.
- `src/lib/idempotency.ts` — canonical request hashing and conflict-safe replay resolution.
- `src/routes/observer-auth.ts` — Apple sign-in, observer session, logout, and account deletion routes.
- `src/routes/observer-sightings.ts` — observer Logbook route.
- `src/services/account-deletion.ts` — deletion/anonymization transaction and media cleanup orchestration.
- `src/lib/s3-storage.ts` — private S3-compatible object storage adapter.
- `src/__tests__/apple-auth.test.ts`, `src/__tests__/observer-auth.test.ts`, `src/__tests__/csrf.test.ts`, `src/__tests__/observer-routes.test.ts`, `src/__tests__/observer-sightings.test.ts`, `src/__tests__/s3-storage.test.ts`, `src/__tests__/account-deletion.test.ts` — focused unit/route suites.
- `tests/integration/observer-submissions.postgres.test.ts` — real PostgreSQL ownership, replay, and deletion coverage.
- `prisma/migrations/20260717170000_add_observer_submissions/migration.sql` — additive observer/session/idempotency schema migration.

### Existing modules changed

- `package.json`, `pnpm-lock.yaml` — add `jose`, S3 client, and S3 presigner.
- `prisma/schema.prisma` — observer role, Apple identity/token fields, named User/Sighting relations, session version, and idempotency record.
- `src/contracts/index.ts`, `src/contracts/sightings.ts`, `scripts/contract-definitions.ts`, generated `contracts/schemas/*.schema.json`, and `contracts/fixtures/*.json` — publish exact client contracts.
- `src/env.ts`, `.env.example`, `src/features.ts`, `src/app.ts` — validate production dependencies and register only enabled routes.
- `src/routes/auth.ts`, `src/lib/auth.ts` — keep admin login compatible while rejecting observer/passwordless accounts.
- `src/routes/sighting-submissions.ts`, `src/routes/sighting-photos.ts` — observer ownership, idempotency, durable media, and compensating cleanup.
- `src/lib/storage.ts` — factory delegation to the real private S3 adapter; retain local disk only for development/test.
- `src/ops/migration-readiness.ts` — require the observer migration.
- `.github/workflows/ci.yml`, `docs/deployment.md`, `docs/rollback.md`, `docs/restore.md` — verification and operational gates.

---

### Task 1: Lock Observer and Submission Contracts

**Files:**
- Create: `src/contracts/auth.ts`
- Modify: `src/contracts/sightings.ts`
- Modify: `src/contracts/index.ts`
- Modify: `scripts/contract-definitions.ts`
- Create: `contracts/fixtures/auth-apple.json`
- Create: `contracts/fixtures/my-sightings.json`
- Create: `contracts/schemas/auth-apple.schema.json`
- Create: `contracts/schemas/my-sightings.schema.json`
- Test: `tests/contracts/contracts.test.ts`
- Test: `tests/contracts/generation.test.ts`

**Interfaces:**
- Produces: `AuthAppleRequestSchema`, `AuthAppleResponseSchema`, `AuthenticatedUserSchema`, `DeleteAccountResponseSchema`, `MySightingPageSchema`, `SubmitSightingPayloadSchema.clientSubmissionId`.
- Consumes: existing `CursorSchema`, `PageInfoSchema`, `SightingStatusSchema`, `SafeErrorSchema`.

- [ ] **Step 1: Write failing contract tests**

Add tests that parse the exact public shapes and reject missing nonce/code, unknown keys, malformed UUID idempotency values, unbounded pages, and leaked observer email:

```typescript
it('accepts the exact Apple exchange and response contracts', () => {
  expect(AuthAppleRequestSchema.parse({
    authorizationCode: 'single-use-code',
    fullName: 'Casey Morgan',
    identityToken: 'header.payload.signature',
    nonce: '64-character-client-nonce',
  })).toMatchObject({ nonce: '64-character-client-nonce' });
  expect(AuthAppleResponseSchema.parse({
    csrfToken: 'csrf-token',
    user: { displayName: 'Casey Morgan', email: 'relay@example.com', id: 'user-1', role: 'OBSERVER' },
  }).user.role).toBe('OBSERVER');
});

it('requires a UUID idempotency key and strips no unknown submission fields', () => {
  expect(() => SubmitSightingPayloadSchema.parse({
    clientSubmissionId: 'not-a-uuid',
    latitude: 48.5,
    longitude: -123,
    observedAt: '2026-07-17T12:00:00.000Z',
    observerEmail: 'observer@example.com',
    unexpected: true,
  })).toThrow();
});

it('never exposes observer email in Logbook rows', () => {
  const parsed = MySightingPageSchema.parse({
    items: [{
      behaviorNotes: null,
      createdAt: '2026-07-17T12:01:00.000Z',
      ecotypeGuess: null,
      groupSize: null,
      id: 'sighting-1',
      latitude: 48.5,
      locationName: null,
      longitude: -123,
      observedAt: '2026-07-17T12:00:00.000Z',
      photoCount: 0,
      rejectionReason: null,
      status: 'PENDING',
    }],
    page: { hasMore: false, nextCursor: null },
  });
  expect(parsed.items[0]).not.toHaveProperty('observerEmail');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm vitest run tests/contracts/contracts.test.ts tests/contracts/generation.test.ts`

Expected: FAIL because the auth schemas, Logbook schema, and `clientSubmissionId` do not exist.

- [ ] **Step 3: Implement strict Zod contracts and fixtures**

Create strict schemas with these exact bounds:

```typescript
export const AuthAppleRequestSchema = z.object({
  authorizationCode: z.string().min(1).max(4096),
  fullName: z.string().trim().min(1).max(120).nullable().optional(),
  identityToken: z.string().min(1).max(16_384),
  nonce: z.string().min(32).max(256),
}).strict();

export const AuthenticatedUserSchema = z.object({
  displayName: z.string().max(120).nullable(),
  email: z.string().email().max(320).nullable(),
  id: StableIdSchema,
  role: z.literal('OBSERVER'),
}).strict();

export const AuthAppleResponseSchema = z.object({
  csrfToken: z.string().min(32).max(512),
  user: AuthenticatedUserSchema,
}).strict();

export const DeleteAccountResponseSchema = z.object({ ok: z.literal(true) }).strict();
```

Add `clientSubmissionId: z.string().uuid()` and `.strict()` to `SubmitSightingPayloadSchema`. Define `MySightingSchema` with the fields in the test and `MySightingPageSchema` with at most 100 items plus `PageInfoSchema`.

- [ ] **Step 4: Generate and verify contracts**

Run: `pnpm contracts:generate && pnpm contracts:check && pnpm vitest run tests/contracts/contracts.test.ts tests/contracts/generation.test.ts`

Expected: generated files are stable and both suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/contracts scripts/contract-definitions.ts contracts tests/contracts
git commit -m "feat: define observer and submission contracts"
```

---

### Task 2: Add Observer, Session, and Idempotency Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260717170000_add_observer_submissions/migration.sql`
- Modify: `src/ops/migration-readiness.ts`
- Test: `tests/migration-readiness.test.ts`
- Test: `tests/integration/observer-submissions.postgres.test.ts`

**Interfaces:**
- Produces: `User.appleSub`, `User.appleRefreshTokenCiphertext`, `User.sessionVersion`, `Sighting.observerUserId`, `SubmissionIdempotency`.
- Consumes: existing `User`, `Sighting`, `UserRole`, and Prisma migration readiness marker.

- [ ] **Step 1: Write failing schema and migration assertions**

```typescript
it('requires the observer migration as the readiness marker', () => {
  expect(REQUIRED_MIGRATION).toBe('20260717170000_add_observer_submissions');
});

it('creates observer ownership and globally unique idempotency keys', () => {
  const schema = readRepositoryFile('prisma/schema.prisma');
  expect(schema).toContain('OBSERVER');
  expect(schema).toContain('observerUserId');
  expect(schema).toContain('model SubmissionIdempotency');
  expect(schema).toContain('keyHash String @unique');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm vitest run tests/migration-readiness.test.ts tests/integration/observer-submissions.postgres.test.ts`

Expected: FAIL on the old migration marker and missing schema fields; PostgreSQL tests skip unless `RUN_POSTGRES_INTEGRATION=true`.

- [ ] **Step 3: Apply the additive Prisma model changes**

Use these exact model properties and named relations:

```prisma
enum UserRole {
  ADMIN
  MODERATOR
  OBSERVER
}

model User {
  id                          String   @id @default(uuid())
  email                       String?  @unique
  passwordHash                String?  @map("password_hash")
  appleSub                    String?  @unique @map("apple_sub")
  displayName                 String?  @map("display_name")
  appleRefreshTokenCiphertext String?  @map("apple_refresh_token_ciphertext")
  sessionVersion              Int      @default(1) @map("session_version")
  role                        UserRole @default(MODERATOR)
  moderatedSightings          Sighting[] @relation("Moderator")
  observedSightings           Sighting[] @relation("Observer")
  submissionIdempotencies     SubmissionIdempotency[]
}

model Sighting {
  observerUserId String? @map("observer_user_id")
  observerUser   User?   @relation("Observer", fields: [observerUserId], references: [id], onDelete: SetNull)
  moderatedBy    User?   @relation("Moderator", fields: [moderatedById], references: [id], onDelete: SetNull)
  idempotencies  SubmissionIdempotency[]
  @@index([observerUserId, observedAt(sort: Desc), id(sort: Desc)])
}

model SubmissionIdempotency {
  id          String   @id @default(uuid())
  keyHash     String   @unique @map("key_hash")
  requestHash String   @map("request_hash")
  userId      String?  @map("user_id")
  user        User?    @relation(fields: [userId], references: [id], onDelete: Cascade)
  sightingId  String   @map("sighting_id")
  sighting    Sighting @relation(fields: [sightingId], references: [id], onDelete: Cascade)
  createdAt   DateTime @default(now()) @map("created_at")
  @@index([userId, createdAt(sort: Desc)])
  @@map("submission_idempotencies")
}
```

Retain every existing User and Sighting field. Change only `email` and `passwordHash` nullability, add named relations, and add the new fields/model.

- [ ] **Step 4: Write the exact SQL migration**

The migration must add enum value `OBSERVER`, nullable columns, foreign keys with `ON DELETE SET NULL`, the ownership index, and the idempotency table. It must not rewrite or delete existing rows. Add comments explaining that existing admin/moderator rows retain password hashes and null Apple identities.

- [ ] **Step 5: Update readiness and run a real PostgreSQL migration**

Run:

```bash
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:migrate:status
RUN_POSTGRES_INTEGRATION=true pnpm vitest run tests/migration-readiness.test.ts tests/integration/observer-submissions.postgres.test.ts
```

Expected: all migrations applied and both suites pass against PostgreSQL 16.

- [ ] **Step 6: Commit**

```bash
git add prisma src/ops/migration-readiness.ts tests/migration-readiness.test.ts tests/integration/observer-submissions.postgres.test.ts
git commit -m "feat: add observer ownership schema"
```

---

### Task 3: Verify Apple Credentials and Encrypt Refresh Tokens

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/services/apple-auth.ts`
- Create: `src/lib/token-crypto.ts`
- Create: `src/__tests__/apple-auth.test.ts`
- Create: `src/__tests__/token-crypto.test.ts`

**Interfaces:**
- Produces: `AppleAuthService(config, dependencies)`, `verifyAppleIdentityToken(token, expectedNonce)`, `exchangeAppleAuthorizationCode(code)`, `revokeAppleRefreshToken(refreshToken)`, `TokenCrypto(encryptionKey)`, `encryptToken(token)`, `decryptToken(ciphertext)`.
- Consumes: constructor-injected `AppleAuthConfig` and decoded 32-byte encryption key; Task 8 validates host values and composes these objects in `src/app.ts`.

- [ ] **Step 1: Add dependencies and failing verifier tests**

Run: `pnpm add jose@6.1.0`

Test signature, exact issuer/audience, expiry, nonce, missing subject, bounded Apple fetch timeout, authorization-code exchange, and sanitized errors. Inject `fetch`, JWKS, and clock rather than reaching Apple in tests:

```typescript
it('rejects a token whose nonce does not match the client nonce', async () => {
  await expect(service.verifyAppleIdentityToken(validToken, 'different-nonce'))
    .rejects.toMatchObject({ code: 'APPLE_TOKEN_INVALID' });
});

it('exchanges a code using the exact native client id', async () => {
  await service.exchangeAppleAuthorizationCode('single-use-code');
  expect(fetchMock).toHaveBeenCalledWith(
    'https://appleid.apple.com/auth/token',
    expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
  );
  const body = String(fetchMock.mock.calls[0]?.[1]?.body);
  expect(body).toContain('client_id=app.fluke.Fluke');
  expect(body).toContain('grant_type=authorization_code');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm vitest run src/__tests__/apple-auth.test.ts src/__tests__/token-crypto.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement Apple verification with `jose`**

Use `createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), { cooldownDuration: 30_000, timeoutDuration: 5_000 })` and `jwtVerify` with:

```typescript
const claims = await jwtVerify(token, appleJwks, {
  algorithms: ['RS256'],
  audience: env.APPLE_CLIENT_ID,
  issuer: 'https://appleid.apple.com',
});
if (!claims.payload.sub || claims.payload.nonce !== expectedNonce) {
  throw new AppleAuthError('APPLE_TOKEN_INVALID');
}
```

Generate the ES256 Apple client-secret JWT with issuer `APPLE_TEAM_ID`, subject `APPLE_CLIENT_ID`, audience `https://appleid.apple.com`, key ID `APPLE_KEY_ID`, and a maximum 180-day expiration. Exchange the authorization code as `application/x-www-form-urlencoded`. Require the token endpoint's `sub` to equal the verified identity-token `sub` before account creation. Revoke using `/auth/revoke` and the stored refresh token.

- [ ] **Step 4: Implement AES-256-GCM token encryption**

Decode exactly 32 bytes from `APPLE_TOKEN_ENCRYPTION_KEY`; generate a random 12-byte IV; authenticate version byte `1`; serialize `version.iv.tag.ciphertext` as base64url components. Decryption rejects unknown version, malformed encoding, wrong tag, and wrong key.

- [ ] **Step 5: Run focused tests**

Run: `pnpm vitest run src/__tests__/apple-auth.test.ts src/__tests__/token-crypto.test.ts`

Expected: all Apple and encryption cases pass without a network request.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/services/apple-auth.ts src/lib/token-crypto.ts src/__tests__/apple-auth.test.ts src/__tests__/token-crypto.test.ts
git commit -m "feat: verify Apple identity credentials"
```

---

### Task 4: Add Separate Observer Sessions and CSRF

**Files:**
- Create: `src/lib/observer-auth.ts`
- Create: `src/lib/csrf.ts`
- Modify: `src/lib/auth.ts`
- Modify: `src/routes/auth.ts`
- Test: `src/__tests__/observer-auth.test.ts`
- Test: `src/__tests__/csrf.test.ts`
- Test: `src/__tests__/auth.test.ts`

**Interfaces:**
- Produces: `issueObserverSession(reply, user)`, `requireObserver(request, reply)`, `resolveOptionalObserver(request, reply)`, `issueCsrfToken(reply)`, `requireCsrf(request, reply)`.
- Consumes: Prisma User `id`, `role`, and `sessionVersion`; dedicated observer env secrets from Task 8.

- [ ] **Step 1: Write failing role-confusion and CSRF tests**

```typescript
it('rejects an admin token at an observer boundary', async () => {
  const token = signAdminToken({ role: 'ADMIN', userId: 'admin-1' });
  await expect(resolveObserverFromToken(token)).rejects.toMatchObject({ statusCode: 401 });
});

it('fails closed when an observer cookie is present but invalid', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/sightings',
    cookies: { fluke_observer: 'invalid' },
    payload: validSubmission,
  });
  expect(response.statusCode).toBe(401);
});

it('requires matching CSRF cookie and header for observer mutations', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
  expect(response.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm vitest run src/__tests__/observer-auth.test.ts src/__tests__/csrf.test.ts src/__tests__/auth.test.ts`

Expected: FAIL because observer session and CSRF helpers do not exist.

- [ ] **Step 3: Implement observer claims and database validation**

Use a dedicated HS256 secret and exact claims:

```typescript
interface ObserverClaims {
  readonly aud: 'fluke-ios-observer';
  readonly role: 'OBSERVER';
  readonly sessionVersion: number;
  readonly sub: string;
  readonly type: 'observer-session';
}
```

Set `fluke_observer` as `httpOnly`, `secure` in production, `sameSite: 'lax'`, `path: '/api/v1'`, and seven-day `maxAge`. Verification must check signature, audience, type, role, and a current database User with matching session version. `resolveOptionalObserver` returns `null` only when the cookie is absent.

- [ ] **Step 4: Implement double-submit CSRF**

Issue a random 32-byte `fluke_csrf` cookie with `secure` in production, `sameSite: 'lax'`, `path: '/api/v1'`, and `httpOnly: false`. Sign the token with `OBSERVER_CSRF_SECRET`; require constant-time equality between cookie and `x-fluke-csrf` header on observer logout and deletion. Submission accepts either no observer cookie or a valid observer session; signed submission also requires CSRF.

- [ ] **Step 5: Harden admin login**

Before `bcrypt.compare`, require `user.role` to be `ADMIN` or `MODERATOR` and `passwordHash` to be non-null. Return the same canonical 401 for absent users, observers, and passwordless rows.

- [ ] **Step 6: Run focused tests**

Run: `pnpm vitest run src/__tests__/observer-auth.test.ts src/__tests__/csrf.test.ts src/__tests__/auth.test.ts`

Expected: all session, CSRF, timing-safe rejection, and existing admin compatibility tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/observer-auth.ts src/lib/csrf.ts src/lib/auth.ts src/routes/auth.ts src/__tests__/observer-auth.test.ts src/__tests__/csrf.test.ts src/__tests__/auth.test.ts
git commit -m "feat: isolate observer sessions and csrf"
```

---

### Task 5: Implement Apple Sign-In and Account Lifecycle Routes

**Files:**
- Create: `src/routes/observer-auth.ts`
- Create: `src/services/account-deletion.ts`
- Create: `src/__tests__/observer-routes.test.ts`
- Create: `src/__tests__/account-deletion.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: `POST /api/v1/auth/apple`, observer-compatible `GET /api/v1/auth/me`, CSRF-protected `POST /api/v1/auth/logout`, `DELETE /api/v1/auth/account`.
- Consumes: contract schemas from Task 1, Apple service from Task 3, session/CSRF helpers from Task 4, and the existing `StorageBackend.remove` interface. Task 6 replaces the production implementation without changing this deletion interface.

- [ ] **Step 1: Write failing route tests**

Cover successful first sign-in, repeat sign-in without overwriting the first non-null name, absent email, email collision without account linking, invalid Apple token, code/subject mismatch, `/me`, logout, deletion reauthentication, token revocation, approved anonymization, pending/rejected deletion, and no secret-bearing logs.

```typescript
it('does not link an Apple subject to an existing email-only account', async () => {
  prisma.user.findUnique.mockResolvedValueOnce(existingAdminWithSameEmail);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/apple',
    payload: validAppleRequest,
  });
  expect(response.statusCode).toBe(409);
  expect(prisma.user.update).not.toHaveBeenCalled();
});

it('deletes pending records and anonymizes approved records', async () => {
  await deleteObserverAccount({ userId: 'observer-1', refreshToken: 'refresh-token' });
  expect(prisma.$transaction).toHaveBeenCalled();
  expect(revokeAppleRefreshToken).toHaveBeenCalledWith('refresh-token');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm vitest run src/__tests__/observer-routes.test.ts src/__tests__/account-deletion.test.ts`

Expected: FAIL because observer routes and deletion service are missing.

- [ ] **Step 3: Implement sign-in transaction**

Validate body, verify identity token and nonce, exchange authorization code, require matching Apple subject, then transact:

- Find by `appleSub` and update only verified email plus first non-null full name.
- If no subject exists but another User owns the verified email, return canonical 409 without linking.
- Otherwise create `role: 'OBSERVER'`, nullable password hash, encrypted refresh token, and session version 1.
- Issue observer and CSRF cookies and return `AuthAppleResponseSchema`.
- Rate-limit to 10 attempts per IP per hour and log only request ID plus failure classification.

- [ ] **Step 4: Implement compatible `/me` and logout**

Keep current admin cookie behavior and response fields. Observer `/me` returns `{ id, userId, email, displayName, role: 'OBSERVER' }`, allowing existing admin clients to continue decoding `userId`. Observer logout verifies CSRF, increments `sessionVersion`, and clears observer/CSRF cookies. Admin logout retains its existing behavior.

- [ ] **Step 5: Implement deletion and Apple revocation**

Require a fresh Apple `identityToken`, `authorizationCode`, and `nonce` in the DELETE body, verify they resolve to the signed-in user's Apple subject, exchange the code, and revoke the stored refresh token. In one database transaction:

- Select pending/rejected photo storage keys for cleanup.
- Delete pending/rejected sightings; cascades remove photo rows and idempotency rows.
- Update approved sightings to `observerUserId: null`, `observerName: null`, and `observerEmail: 'deleted-observer@privacy.invalid'`.
- Delete the User, audit logs, and remaining idempotency records.

After commit, remove selected objects with bounded retries; record cleanup failures as server diagnostics without restoring PII. Clear cookies and return `{ ok: true }`.

- [ ] **Step 6: Run focused tests**

Run: `pnpm vitest run src/__tests__/observer-routes.test.ts src/__tests__/account-deletion.test.ts src/__tests__/auth.test.ts`

Expected: all observer lifecycle and existing admin cases pass.

- [ ] **Step 7: Commit**

```bash
git add src/routes/observer-auth.ts src/services/account-deletion.ts src/app.ts src/__tests__/observer-routes.test.ts src/__tests__/account-deletion.test.ts
git commit -m "feat: add observer account lifecycle"
```

---

### Task 6: Replace Production Local Media with Durable Private S3 Storage

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/lib/s3-storage.ts`
- Modify: `src/lib/storage.ts`
- Modify: `src/routes/sighting-photos.ts`
- Create: `src/__tests__/s3-storage.test.ts`
- Modify: `src/__tests__/sighting-photos.test.ts`
- Modify: `src/__tests__/storage.test.ts`

**Interfaces:**
- Produces: `S3StorageBackend(config, client)`, `.put`, `.remove`, `.signedReadUrl`; atomic `storeSightingPhoto` cleanup behavior.
- Consumes: constructor-injected `S3StorageConfig` and existing `StorageBackend` call sites. Task 8 validates host values and constructs the production adapter in `src/app.ts`.

- [ ] **Step 1: Add S3 dependencies and write failing adapter tests**

Run: `pnpm add @aws-sdk/client-s3@3.883.0 @aws-sdk/s3-request-presigner@3.883.0`

```typescript
it('writes private objects with the declared image type', async () => {
  await storage.put({ body: image, contentType: 'image/webp', filename: 'large.webp', prefix: 'sightings/s-1' });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({
    Bucket: 'fluke-private',
    ContentType: 'image/webp',
    Key: 'sightings/s-1/large.webp',
  }) }));
});

it('removes the first object when the second upload fails', async () => {
  storage.put.mockResolvedValueOnce(large).mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(storePhotoPair(input)).rejects.toThrow();
  expect(storage.remove).toHaveBeenCalledWith(large.key);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm vitest run src/__tests__/s3-storage.test.ts src/__tests__/storage.test.ts src/__tests__/sighting-photos.test.ts`

Expected: FAIL because S3 adapter and compensating cleanup are missing.

- [ ] **Step 3: Implement the private S3 adapter**

Configure `S3Client` from validated env, omit public ACLs, and keep bucket keys private. `put` returns key and byte count; `signedReadUrl` produces a five-minute GET URL; `remove` is idempotent for missing keys. Preserve prefix and filename traversal rejection from local storage.

- [ ] **Step 4: Harden image processing and compensation**

Use `sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 })`, rotate, resize, and emit WebP without source metadata. Upload large first, thumbnail second, then create the database row. On second-upload failure remove the large object; on database failure remove both. Await cleanup with `Promise.allSettled` and log keys only at server error level.

- [ ] **Step 5: Keep pending photos private**

Do not persist permanent public URLs. Store opaque keys in `storageKey`; make `url` and `thumbnailUrl` contain the API origin plus `/api/v1/media/:photoId` compatibility path. The media route returns a short signed redirect only when the sighting is approved, the caller owns the pending sighting, or the caller is an admin. Add cross-user 403 and approved-public 302 tests.

- [ ] **Step 6: Run focused tests**

Run: `pnpm vitest run src/__tests__/s3-storage.test.ts src/__tests__/storage.test.ts src/__tests__/sighting-photos.test.ts`

Expected: adapter, privacy, pixel-limit, metadata stripping, and every compensation path pass.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/s3-storage.ts src/lib/storage.ts src/routes/sighting-photos.ts src/__tests__/s3-storage.test.ts src/__tests__/storage.test.ts src/__tests__/sighting-photos.test.ts
git commit -m "feat: persist private sighting media"
```

---

### Task 7: Add Idempotent Submit and Observer Logbook

**Files:**
- Create: `src/lib/idempotency.ts`
- Create: `src/routes/observer-sightings.ts`
- Modify: `src/routes/sighting-submissions.ts`
- Modify: `src/app.ts`
- Create: `src/__tests__/observer-sightings.test.ts`
- Modify: `src/__tests__/sightings.test.ts`
- Modify: `tests/integration/observer-submissions.postgres.test.ts`

**Interfaces:**
- Produces: replay-safe `POST /api/v1/sightings`; cursor-bounded `GET /api/v1/sightings/me`.
- Consumes: observer resolver/CSRF, `clientSubmissionId`, Prisma `SubmissionIdempotency`, cursor helpers.

- [ ] **Step 1: Write failing replay and isolation tests**

```typescript
it('returns the original sighting for an exact replay', async () => {
  const first = await submit(validSubmission, observerCookies);
  const second = await submit(validSubmission, observerCookies);
  expect(first.statusCode).toBe(201);
  expect(second.statusCode).toBe(200);
  expect(second.json().id).toBe(first.json().id);
  expect(prisma.sighting.create).toHaveBeenCalledTimes(1);
});

it('returns 409 when the same idempotency key carries different data', async () => {
  await submit(validSubmission, observerCookies);
  const response = await submit({ ...validSubmission, latitude: 49 }, observerCookies);
  expect(response.statusCode).toBe(409);
});

it('never returns another observer account\'s sightings', async () => {
  const response = await getMySightings(observerOneCookies);
  expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(['observer-one-sighting']);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm vitest run src/__tests__/sightings.test.ts src/__tests__/observer-sightings.test.ts`

Expected: FAIL because retries create multiple rows and Logbook route is absent.

- [ ] **Step 3: Implement canonical request hashing**

Hash the UTF-8 bytes of stable JSON containing every validated submission field plus authentication scope. Hash the idempotency UUID before persistence. For observers scope with `observer:<userId>`; for anonymous submission scope with `anonymous:<observerEmail lowercased>`. Never log or return either hash.

- [ ] **Step 4: Implement transaction-safe submission replay**

Resolve optional observer before database work. Signed submission requires CSRF. In a serializable transaction:

- Look up `keyHash`; exact `requestHash` returns the prior sighting and a newly issued photo-upload token.
- A different request hash returns canonical 409.
- Otherwise create the pending sighting with `observerUserId`, then create its idempotency record.
- If concurrent creation raises Prisma unique conflict, reread and apply the same exact-replay/conflict rule.

Return 201 for creation and 200 for exact replay. Keep the existing hourly rate limit and 24-hour sighting-scoped photo token.

- [ ] **Step 5: Implement cursor-bounded Logbook**

Require observer auth and query only `observerUserId=request.observer.id`, ordered by `observedAt DESC, id DESC`, with `limit` 1–100 and opaque cursor. Select only `MySightingSchema` fields, include status/rejection reason/photo count, and never return observer identity or storage keys.

- [ ] **Step 6: Run unit and real PostgreSQL tests**

Run:

```bash
pnpm vitest run src/__tests__/sightings.test.ts src/__tests__/observer-sightings.test.ts
RUN_POSTGRES_INTEGRATION=true pnpm vitest run tests/integration/observer-submissions.postgres.test.ts
```

Expected: replay, concurrent replay, mismatch conflict, pagination, and cross-user isolation pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/idempotency.ts src/routes/observer-sightings.ts src/routes/sighting-submissions.ts src/app.ts src/__tests__/sightings.test.ts src/__tests__/observer-sightings.test.ts tests/integration/observer-submissions.postgres.test.ts
git commit -m "feat: add idempotent observer submissions"
```

---

### Task 8: Open Only the Safe Production Capability Combination

**Files:**
- Modify: `src/env.ts`
- Modify: `.env.example`
- Modify: `src/features.ts`
- Modify: `src/app.ts`
- Modify: `tests/release-a-config.test.ts`
- Modify: `tests/release-a-route-matrix.test.ts`
- Create: `tests/release-b-config.test.ts`

**Interfaces:**
- Produces: validated production feature state and required Apple/storage secrets.
- Consumes: all route plugins and dependencies from Tasks 3–7.

- [ ] **Step 1: Write failing production matrix tests**

```typescript
it.each([
  { ENABLE_ACCOUNTS: 'true', ENABLE_SUBMISSIONS: 'false' },
  { ENABLE_ACCOUNTS: 'false', ENABLE_SUBMISSIONS: 'true' },
  { ENABLE_ACCOUNTS: 'true', ENABLE_SUBMISSIONS: 'true', ENABLE_IDENTIFY: 'true' },
])('rejects unsafe production capability combinations', (flags) => {
  expect(() => parseEnv({ ...SAFE_RELEASE_B_ENV, ...flags })).toThrow();
});

it('accepts accounts plus submissions with identify disabled and all dependencies', () => {
  const env = parseEnv(SAFE_RELEASE_B_ENV);
  expect(createFeatureConfig(env)).toEqual({ accounts: true, identification: false, submissions: true });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm vitest run tests/release-a-config.test.ts tests/release-b-config.test.ts tests/release-a-route-matrix.test.ts`

Expected: Release B safe state is rejected by the current Release A-only production check.

- [ ] **Step 3: Add exact environment schema**

Add these variables:

```typescript
APPLE_CLIENT_ID: z.literal('app.fluke.Fluke').optional(),
APPLE_TEAM_ID: z.literal('86RBV2JZ8F').optional(),
APPLE_KEY_ID: z.string().regex(/^[A-Z0-9]{10}$/u).optional(),
APPLE_PRIVATE_KEY: z.string().includes('BEGIN PRIVATE KEY').optional(),
APPLE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
OBSERVER_JWT_SECRET: z.string().min(43).optional(),
OBSERVER_CSRF_SECRET: z.string().min(43).optional(),
PRODUCTION_MUTATIONS_ACK: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
OBJECT_STORAGE_BUCKET: z.string().min(3).optional(),
OBJECT_STORAGE_REGION: z.string().min(1).optional(),
OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
OBJECT_STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
```

For production, accept all-off as Release A. Accept accounts-plus-submissions only with `PRODUCTION_MUTATIONS_ACK=true`, identify false, `STORAGE_BACKEND='s3'`, and every Apple/observer/storage value present and valid. Reject every partial combination and every production identify enablement.

- [ ] **Step 4: Register exact feature-owned routes**

When `accounts` is true register admin auth/admin routes plus observer auth and observer Logbook. When `submissions` is true register submit/photo/media routes. Register identify only when identification is true; the production validator guarantees this never happens.

- [ ] **Step 5: Update environment documentation and tests**

Document all variables in `.env.example` with safe false/off defaults and generation commands:

```bash
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 32
```

Do not include real credentials or usable example private keys.

- [ ] **Step 6: Run configuration and route matrix tests**

Run: `pnpm vitest run tests/release-a-config.test.ts tests/release-b-config.test.ts tests/release-a-route-matrix.test.ts`

Expected: Release A remains fail-closed; safe Release B registers accounts/submissions; every identify production case fails startup.

- [ ] **Step 7: Commit**

```bash
git add src/env.ts .env.example src/features.ts src/app.ts tests/release-a-config.test.ts tests/release-b-config.test.ts tests/release-a-route-matrix.test.ts
git commit -m "feat: gate production observer capabilities"
```

---

### Task 9: Add Full Integration, Security, and CI Gates

**Files:**
- Modify: `tests/integration/observer-submissions.postgres.test.ts`
- Create: `tests/observer-security.test.ts`
- Modify: `tests/http-hardening.test.ts`
- Modify: `vitest.config.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `Dockerfile`

**Interfaces:**
- Produces: remote proof that migration, auth, isolation, deletion, media, firewall, and container readiness work together.
- Consumes: all implementation tasks.

- [ ] **Step 1: Write failing end-to-end API integration tests**

Test with real PostgreSQL and injected fake Apple/S3 adapters:

- Apple sign-in creates one observer and stores only encrypted refresh token.
- Wrong issuer, audience, nonce, expiry, subject, code, signature, and JWKS timeout all fail canonical 401/503 as classified.
- Two concurrent identical submissions produce one Sighting.
- Cross-observer Logbook and pending-media access fail 403 without data leakage.
- Approved media is publicly retrievable only through short signed redirect.
- Account deletion revokes Apple, removes pending/rejected data, anonymizes approved data, deletes user, and invalidates old JWT.
- Production capabilities are exact and identify remains 404.

- [ ] **Step 2: Run integration tests and verify RED**

Run: `RUN_POSTGRES_INTEGRATION=true pnpm vitest run tests/integration/observer-submissions.postgres.test.ts tests/observer-security.test.ts tests/http-hardening.test.ts`

Expected: at least one new integration/security assertion fails before final wiring is complete.

- [ ] **Step 3: Wire CI production dependencies with non-secret fakes**

Add test-only fake Apple keys/tokens generated during the job and a local S3-compatible service container. Never commit a private key used outside CI. Run PostgreSQL integration, migrations, contract generation check, typecheck, lint, coverage, audit, Gitleaks, Docker build, and a production container smoke with safe Release B env.

- [ ] **Step 4: Add dual container smoke matrix**

Smoke one Release A container and one safe Release B container. Require:

```bash
curl --fail http://localhost:4000/api/v1/ready
test "$(curl --silent http://localhost:4000/api/v1/capabilities)" = '{"accounts":true,"identification":false,"submissions":true}'
test "$(curl --silent --output /dev/null --write-out '%{http_code}' -X POST http://localhost:4000/api/v1/identify)" = '404'
```

Keep stopped containers long enough to print logs, then force-remove them in a trap.

- [ ] **Step 5: Run the complete local verification**

Run:

```bash
pnpm db:generate
pnpm contracts:check
pnpm typecheck
pnpm lint
RUN_POSTGRES_INTEGRATION=true pnpm test:coverage
pnpm build
pnpm audit
```

Expected: all commands exit 0; coverage is at least 80 percent for lines, branches, functions, and statements.

- [ ] **Step 6: Commit**

```bash
git add tests vitest.config.ts .github/workflows/ci.yml Dockerfile
git commit -m "ci: certify observer submission release"
```

---

### Task 10: Document Deploy, Rollback, Restore, and Production Certification

**Files:**
- Modify: `docs/deployment.md`
- Modify: `docs/rollback.md`
- Modify: `docs/restore.md`
- Create: `docs/observer-operations.md`
- Test: `tests/release-config.test.ts`

**Interfaces:**
- Produces: an operator-executable launch and rollback sequence with stop conditions.
- Consumes: exact env and routes from all previous tasks.

- [ ] **Step 1: Write failing documentation assertions**

```typescript
it('documents the exact observer launch and identify stop gates', () => {
  const deployment = readRepositoryFile('docs/deployment.md');
  expect(deployment).toContain('{"accounts":true,"identification":false,"submissions":true}');
  expect(deployment).toContain('POST /api/v1/identify must return 404');
  expect(deployment).toContain('media survives an API redeploy');
});

it('rolls flags off before reverting code', () => {
  const rollback = readRepositoryFile('docs/rollback.md');
  expect(rollback.indexOf('ENABLE_ACCOUNTS=false')).toBeLessThan(rollback.indexOf('redeploy the previous image'));
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run tests/release-config.test.ts`

Expected: FAIL because the observer production runbook does not exist.

- [ ] **Step 3: Write the exact deployment sequence**

Document:

1. Confirm external prerequisites and privacy disclosures.
2. Require the exact GitHub Actions SHA green.
3. Create a Neon restore point and record database identity.
4. Apply `20260717170000_add_observer_submissions`; run migration status and seed verifier.
5. Configure Apple, observer, encryption, and private S3 secrets with flags still false.
6. Deploy the exact SHA and require health/ready 200 with all capabilities false.
7. Exercise fake-free production Apple sign-in on a physical TestFlight device.
8. Set `PRODUCTION_MUTATIONS_ACK=true`, `ENABLE_ACCOUNTS=true`, `ENABLE_SUBMISSIONS=true`, `ENABLE_IDENTIFY=false`; redeploy.
9. Require exact capabilities JSON and Identify 404.
10. Exercise anonymous and signed submissions, exact offline replay, Logbook isolation, signed media, deletion/revocation, and media persistence across one Render redeploy.
11. Stop certification on any non-200 health/readiness response, migration issue, storage cleanup error, Apple verification error, capability mismatch, Identify route exposure, cross-user access, duplicate replay row, or failed deletion.

- [ ] **Step 4: Write rollback and restore sequence**

Rollback begins by setting accounts/submissions false and redeploying while identify remains false. Verify mutation/auth routes return 404, preserve database/media, then redeploy the previous green image. Restore documentation must cover database restore, object inventory reconciliation, key rotation after compromise, and verification that no restored observer session version becomes valid unexpectedly.

- [ ] **Step 5: Run final repository verification**

Run:

```bash
pnpm layout:check
pnpm contracts:check
pnpm typecheck
pnpm lint
pnpm test:coverage
pnpm build
pnpm audit
git diff --check
```

Expected: every command exits 0 and no whitespace errors are reported.

- [ ] **Step 6: Commit**

```bash
git add docs/deployment.md docs/rollback.md docs/restore.md docs/observer-operations.md tests/release-config.test.ts
git commit -m "docs: add observer launch operations"
```

---

## Final Production Gate

Production observer capabilities are complete only when all of the following are recorded against the same deployed Git SHA:

- GitHub Actions CI is green with PostgreSQL integration, coverage, audit, Gitleaks, image build, and dual container smoke.
- `/api/v1/health` and `/api/v1/ready` return 200.
- `/api/v1/capabilities` returns exactly `{\"accounts\":true,\"identification\":false,\"submissions\":true}`.
- `POST /api/v1/identify` returns canonical 404.
- A physical TestFlight device completes Apple sign-in, `/auth/me`, logout, and re-sign-in.
- Anonymous and signed submissions work; exact offline replay creates one database row.
- Observer A cannot read Observer B's Logbook or pending media.
- Photos remain available after a Render redeploy and partial failures leave no orphaned objects.
- In-app account deletion revokes Apple authorization, clears the client, deletes pending/rejected data, and anonymizes approved data.
- Updated privacy/support pages are publicly reachable and App Store privacy answers match the verified flows.
- The rollback drill closes accounts/submissions while keeping browse routes healthy and Identify closed.
