#!/bin/sh
set -eu

echo "[entrypoint] migrate"
bun /app/dist/migrate.js

echo "[entrypoint] seed (idempotent)"
bun /app/dist/seed.js || echo "[entrypoint] seed reported non-zero — continuing"

echo "[entrypoint] start"
exec "$@"
