FROM node:22.17.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vitest.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
RUN pnpm db:generate && pnpm build && pnpm prune --prod

FROM node:22.17.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV UPLOADS_DIR=/app/uploads
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 4000
CMD ["node", "dist/src/index.js"]
