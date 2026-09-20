# syntax=docker/dockerfile:1

# Deployment image (SPEC.md section 10). Two build targets share one file:
#
# - `app` (default): Node image that applies migrations, then runs the
#   Fastify API with the worker beside it. APP_ROLE switches the role.
# - `web`: nginx gateway that serves the built PWA and forwards same-origin
#   /api requests to the `app` container with the prefix stripped. The
#   platform proxy (Coolify) terminates TLS in front of it.
#
# Build from the repository root:
#   docker build --target app -t mail-hub-app .
#   docker build --target web -t mail-hub-web .

FROM node:24-alpine AS web-build
WORKDIR /app

# Install dependencies from the lockfile first so source changes do not
# invalidate the dependency layers. Every workspace manifest must be present
# for `npm ci` to link the @mail-hub/* packages.
COPY package.json package-lock.json .npmrc tsconfig.base.json tsconfig.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/accounts/package.json packages/accounts/package.json
COPY packages/actions/package.json packages/actions/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/classification/package.json packages/classification/package.json
COPY packages/compose/package.json packages/compose/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/content/package.json packages/content/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/harness/package.json packages/harness/package.json
COPY packages/home/package.json packages/home/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/offline/package.json packages/offline/package.json
COPY packages/reading/package.json packages/reading/package.json
COPY packages/recovery/package.json packages/recovery/package.json
COPY packages/search/package.json packages/search/package.json
COPY packages/send/package.json packages/send/package.json
COPY packages/settings/package.json packages/settings/package.json
COPY packages/sync/package.json packages/sync/package.json
COPY packages/transport/package.json packages/transport/package.json
RUN npm ci

COPY . .
RUN npm run build --workspace=@mail-hub/web

FROM node:24-alpine AS app
# pg_dump and pg_restore for the in-container backup and restore procedures.
# Keep this client at the same or a newer major version than the PostgreSQL
# server; deploy/README.md records the constraint.
RUN apk add --no-cache postgresql-client
WORKDIR /app

# NODE_ENV stays unset: the image runs TypeScript and migrations from source,
# so npm ci must install every workspace's dev dependencies (tsx, drizzle-kit).
ENV HOST=0.0.0.0 \
    PORT=3000 \
    STORAGE_ROOT=/app/data/storage

COPY package.json package-lock.json .npmrc tsconfig.base.json tsconfig.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/accounts/package.json packages/accounts/package.json
COPY packages/actions/package.json packages/actions/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/classification/package.json packages/classification/package.json
COPY packages/compose/package.json packages/compose/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/content/package.json packages/content/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/harness/package.json packages/harness/package.json
COPY packages/home/package.json packages/home/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/offline/package.json packages/offline/package.json
COPY packages/reading/package.json packages/reading/package.json
COPY packages/recovery/package.json packages/recovery/package.json
COPY packages/search/package.json packages/search/package.json
COPY packages/send/package.json packages/send/package.json
COPY packages/settings/package.json packages/settings/package.json
COPY packages/sync/package.json packages/sync/package.json
COPY packages/transport/package.json packages/transport/package.json
RUN npm ci

COPY . .

# Durable originals, uploads, and outbound MIME bytes land under this
# directory. Mount a volume over it. The image owns the directory to the
# unprivileged runtime user so a fresh named volume inherits that ownership.
RUN mkdir -p /app/data/storage \
    && chown -R node:node /app/data
USER node

EXPOSE 3000

# The deployment health check (SPEC.md sections 10 and 11). Busybox wget is
# present in the alpine base. The check answers 503 while the database is
# unreachable; enrollment and recovery stay available otherwise.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["sh", "/app/deploy/entrypoint.sh"]

FROM nginx:1-alpine AS web
# The gateway: static PWA plus the /api reverse proxy. TLS is terminated by
# the platform proxy in front of this listener. The official nginx image
# substitutes MAIL_HUB_API_HOST into the template at startup; compose sets it
# to the api service name, a separate Coolify app sets it to its hostname.
ENV MAIL_HUB_API_HOST=api:3000
COPY deploy/nginx-web.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
