# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY docs/design-tokens.json ./docs/design-tokens.json
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]

FROM node:22-bookworm-slim AS jobs
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
CMD ["node", "packages/db/dist/migrate.js", "up"]

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
