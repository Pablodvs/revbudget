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

DB_FILE="${DATABASE_URL:-/app/data/revbudget.db}"

# First-run detection must happen BEFORE migrate creates the file. -s also
# treats a 0-byte leftover from a crashed first boot as fresh.
if [ -s "$DB_FILE" ]; then
  FRESH_DB=0
else
  FRESH_DB=1
fi

echo "[entrypoint] migrate"
bun /app/dist/migrate.js

# Seed only on first run: re-seeding on every boot resurrected the demo
# wallets after a user had deliberately deleted them all.
if [ "$FRESH_DB" = "1" ]; then
  echo "[entrypoint] fresh database — seeding default wallets"
  bun /app/dist/seed.js || echo "[entrypoint] seed reported non-zero — continuing"
else
  echo "[entrypoint] existing database — skipping seed (manual: bun /app/dist/seed.js)"
fi

echo "[entrypoint] start"
exec "$@"
