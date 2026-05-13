# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.12

# ─────────────────────────────────────────────────────────────────
# deps: install workspace dependencies with a frozen lockfile
# ─────────────────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json

RUN bun install --frozen-lockfile

# ─────────────────────────────────────────────────────────────────
# build: bundle the dashboard (Vite) and the server (bun build)
# ─────────────────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app

# Vite inlines VITE_* at build time. Empty VITE_API_URL ⇒ same-origin requests.
# Auth uses cookie sessions, so no token gets baked into the dashboard bundle.
ENV VITE_API_URL=""

# Bun's workspace install puts hoisted deps in /app/node_modules and
# workspace-local binaries (e.g. vue-tsc, vite) under <workspace>/node_modules.
# Both trees need to land in the build stage.
COPY --from=deps /app/node_modules            ./node_modules
COPY --from=deps /app/shared/node_modules     ./shared/node_modules
COPY --from=deps /app/server/node_modules     ./server/node_modules
COPY --from=deps /app/dashboard/node_modules  ./dashboard/node_modules
COPY . .

RUN bun run --cwd dashboard build \
 && bun build server/src/index.ts       --target=bun --outdir=dist \
 && bun build server/src/db/migrate.ts  --target=bun --outdir=dist \
 && bun build server/src/db/seed.ts     --target=bun --outdir=dist \
 && cp -r server/src/db/migrations dist/migrations

# ─────────────────────────────────────────────────────────────────
# runner: minimal runtime image
# ─────────────────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-alpine AS runner
WORKDIR /app

# The app runs as the bun user (uid:gid 1000:1000) that ships in oven/bun.
# We don't set `USER bun` here on purpose: the entrypoint starts as root so it
# can chown a freshly-mounted /app/data (Coolify-managed volumes come up
# root-owned and would otherwise block sqlite writes), then drops to bun via
# su-exec before running migrations and the app.
RUN apk add --no-cache curl tini su-exec \
 && mkdir -p /app/data \
 && chown -R bun:bun /app

ENV NODE_ENV=production

COPY --from=build --chown=bun:bun /app/dist             /app/dist
COPY --from=build --chown=bun:bun /app/dashboard/dist   /app/dashboard/dist
COPY --chown=bun:bun docker/entrypoint.sh               /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["bun", "/app/dist/index.js"]
