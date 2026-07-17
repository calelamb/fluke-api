# Fluke API

The standalone Fastify and Prisma API for Fluke.

## Local development

Use Node.js 22.17.0 and pnpm 10.33.0, copy `.env.example` to `.env`, and then run:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm dev
```

Run `pnpm layout:check` to verify that API source, scripts, and Prisma files remain rooted at the repository top level.
