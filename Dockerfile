# OpenCron for self-hosting: the web app, the API and the scheduler in one Node process, with PostgreSQL.
# Script jobs run in the separate sandbox service (apps/sandbox/Dockerfile). See docs/docker.md.

FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# the public address goes into the pages' canonical, hreflang and Open Graph links, robots.txt and the sitemap
ARG APP_URL=http://localhost:8080
ENV APP_URL=$APP_URL
RUN pnpm --filter @opencron/web build && pnpm --filter @opencron/api build:node

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /src/apps/api/dist/server.mjs apps/api/dist/server.mjs
COPY --from=build /src/apps/api/migrations/postgres apps/api/migrations/postgres
COPY --from=build /src/apps/web/dist apps/web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "apps/api/dist/server.mjs"]
