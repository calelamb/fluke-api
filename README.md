# Fluke API

Fluke API is the standalone HTTP service for Fluke's public whale catalog, sightings, predictions, photo workflows, and administrative tools. It owns the runtime API contracts and PostgreSQL schema used by the web and iOS clients.

## Architecture

- [Fastify](https://fastify.dev/) serves versioned routes under `/api/v1`.
- [Prisma](https://www.prisma.io/) owns the PostgreSQL schema and migrations in `prisma/`.
- Zod schemas in `src/contracts/` validate data at service boundaries.
- Generated JSON Schema and fixture artifacts in `contracts/` give clients deterministic compatibility inputs.
- Photo storage uses the local filesystem by default. The R2 configuration is reserved for the storage adapter and requires all `R2_*` values.

This repository preserves the API and shared-contract history extracted from the original `calelamb/fluke` monorepo. New API behavior, migrations, and canonical contracts belong here.

## Requirements

- Node.js `22.17.0`
- pnpm `10.33.0`
- PostgreSQL compatible with the committed Prisma migrations

Corepack can install the pinned package manager:

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
```

## Local development

Copy `.env.example` to `.env`, replace its placeholders, then install and prepare the client:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate:deploy
pnpm dev
```

The development server listens on `http://localhost:4000` by default. `pnpm db:migrate:deploy` applies committed migrations only; create and review new migrations in a development database before committing their SQL.

Useful commands:

| Command | Purpose |
| --- | --- |
| `pnpm layout:check` | Reject legacy monorepo paths and verify the standalone layout. |
| `pnpm contracts:generate` | Regenerate deterministic schemas and fixtures from API-owned contracts. |
| `pnpm contracts:check` | Fail when generated contract artifacts have drifted. |
| `pnpm typecheck` | Type-check without emitting JavaScript. |
| `pnpm lint` | Run ESLint across runtime code, scripts, and the seed. |
| `pnpm test` | Run the Vitest unit and integration suite. |
| `pnpm test:coverage` | Run tests with the enforced 80% line threshold. |
| `pnpm build` | Compile production JavaScript to `dist/`. |
| `pnpm audit` | Reject high or critical production dependency advisories. |

## Environment

All environment input is validated at startup. The process exits with field-specific guidance when required configuration is missing or malformed.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Pooled PostgreSQL connection used by the running API. |
| `DIRECT_URL` | Yes | Direct PostgreSQL connection used by Prisma migrations. |
| `JWT_SECRET` | Yes | Random secret of at least 32 characters. Generate it outside source control. |
| `NODE_ENV` | No | `development`, `production`, or `test`; defaults to `development`. |
| `PORT` | No | HTTP port; defaults to `4000`. |
| `ADMIN_COOKIE_NAME` | No | Admin authentication cookie; defaults to `fluke_admin`. |
| `WEB_ORIGIN` | No | Comma-separated browser origins allowed by CORS. |
| `API_PUBLIC_ORIGIN` | No | Public API origin used to create absolute photo URLs. |
| `IDENTIFIER_SERVICE_URL` | No | Base URL for the separate identifier service. |
| `STORAGE_BACKEND` | No | `local` or `r2`; defaults to `local`. |
| `UPLOADS_DIR` | No | Local upload directory; defaults to `uploads` in source. The container sets `/app/uploads`. |
| `R2_BUCKET` | For R2 | R2 bucket name. |
| `R2_ENDPOINT` | For R2 | R2 S3-compatible endpoint. |
| `R2_ACCESS_KEY_ID` | For R2 | R2 access key ID. |
| `R2_SECRET_ACCESS_KEY` | For R2 | R2 secret access key. |
| `R2_PUBLIC_HOST` | For R2 | Public origin for stored objects. |

Never commit `.env` or production credentials. CI uses isolated, synthetic test-only values.

## Health checks

- `GET /api/v1/health` is a liveness check. It returns `200` without touching the database, so an orchestrator only restarts a process that cannot serve HTTP.
- `GET /api/v1/ready` is a readiness check. It runs a bounded `SELECT 1` probe and returns `200 {"status":"ready"}` when PostgreSQL is reachable. Probe failures return `503 {"status":"unready"}` without exposing database errors.

Use readiness for release health checks and traffic admission. Do not use liveness to decide whether a database migration succeeded.

## Contract artifacts

The API is the source of truth for runtime contracts. After changing a contract:

```bash
pnpm contracts:generate
pnpm contracts:check
pnpm test
```

Commit the matching files in `contracts/schemas/` and `contracts/fixtures/`. Client repositories consume those artifacts instead of importing API source.

## Container

The multi-stage image pins Node and pnpm, prunes development dependencies, and runs as the unprivileged `node` user:

```bash
docker build --tag fluke-api:local .
docker run --rm --publish 4000:4000 \
  --env-file .env \
  --env NODE_ENV=production \
  --env UPLOADS_DIR=/app/uploads \
  --volume fluke-api-uploads:/app/uploads \
  fluke-api:local
curl --fail http://localhost:4000/api/v1/ready
```

The runtime image already sets `NODE_ENV=production` and `UPLOADS_DIR=/app/uploads`; the explicit flags above document the effective values and the volume's writable mount point. CI overrides its test-process environment with `NODE_ENV=production` when it smokes the pruned runtime image.

Database migrations are intentionally not part of the image startup command. Apply them as a separate, observable release step before starting the new application image:

```bash
pnpm db:migrate:deploy
```

## Railway release

`railway.json` selects the repository Dockerfile and uses `/api/v1/ready` for release health. To release:

1. Create a Railway service from this repository and attach a PostgreSQL service or approved external database.
2. Configure the validated environment variables in Railway; keep secrets out of build arguments and source control.
3. Run `pnpm db:migrate:deploy` as a separate production release step against `DIRECT_URL`.
4. Deploy the image and require the Railway readiness check to pass before routing traffic.
5. Probe both `/api/v1/health` and `/api/v1/ready` on the public API origin after release.

A Railway deployment marked successful is not sufficient on its own: the public readiness probe must return the expected `200` response before the release is certified.

## CI release gates

GitHub Actions installs the pinned toolchain, starts PostgreSQL, applies migrations, checks standalone layout and contract drift, type-checks, lints, enforces coverage, builds, audits production dependencies, and installs Gitleaks `8.30.1`. The action's event scan runs without PR comments under read-only permissions, followed by an explicit `--all` full-history scan. CI then builds the non-root container and verifies it in production mode against the migrated PostgreSQL service.

Run the locally available equivalents before pushing:

```bash
pnpm layout:check
pnpm contracts:check
pnpm typecheck
pnpm lint
pnpm test:coverage
pnpm build
pnpm audit
gitleaks git --log-opts=--all --redact --no-banner .
git diff --check
git fsck --full --strict
```
