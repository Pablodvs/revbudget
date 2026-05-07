#!/bin/sh
set -eu

# Fresh bind mounts and Coolify-managed volumes come up root-owned, which
# blocks the uid:1000 bun user from creating the sqlite file. When booting as
# root, fix ownership on the data dir and re-exec self as bun. Local mounts
# that are already bun-owned: chown is a no-op.
if [ "$(id -u)" = "0" ]; then
  chown -R bun:bun /app/data
  exec su-exec bun "$0" "$@"
fi

echo "[entrypoint] migrate"
bun /app/dist/migrate.js

echo "[entrypoint] seed (idempotent)"
bun /app/dist/seed.js || echo "[entrypoint] seed reported non-zero — continuing"

echo "[entrypoint] start"
exec "$@"
