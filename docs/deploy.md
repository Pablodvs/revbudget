# Deploying RevBudget

RevBudget ships as a single Docker image: the Hono server, the built dashboard and SQLite in one container. In production, a `cloudflared` sidecar makes the app reachable from the internet with **no open host ports**.

- [The image](#the-image)
- [Configuration](#configuration)
- [Local Docker (no tunnel)](#local-docker-no-tunnel)
- [Docker Compose with Cloudflare Tunnel](#docker-compose-with-cloudflare-tunnel)
- [Coolify](#coolify)
- [First admin](#first-admin)
- [Ollama (optional)](#ollama-optional)
- [Data, migrations and backups](#data-migrations-and-backups)
- [Verifying a deployment](#verifying-a-deployment)
- [Updating](#updating)
- [Without Docker](#without-docker)

## The image

`Dockerfile` has three stages:

1. **deps:** `bun install --frozen-lockfile`.
2. **build:** Vite builds the SPA, and `bun build` bundles the server, migrator, wallet seed and `create-admin` CLI into `dist/`.
3. **runner:** a slim runtime image.

The runtime image:

- uses `oven/bun:<version>-alpine`, pinned by digest;
- runs `tini` as PID 1, with a `curl` healthcheck on `/api/health`;
- has app code (`/app/dist`, `/app/dashboard/dist`) and the entrypoint owned by root and **read-only for the runtime user**, which can write only `/app/data`.

`docker/entrypoint.sh` starts as root only long enough to `chown` a freshly mounted `/app/data`. It then drops to the unprivileged `bun` user with `su-exec` and does three things:

1. Runs the migrations.
2. Seeds the 7 default wallets, but only when the database file didn't exist yet.
3. Starts the server.

`docker-compose.yml` adds these hardening settings on top:

- `cap_drop: ALL` (the app keeps only `CHOWN`, `SETUID` and `SETGID` for that hand-off);
- `no-new-privileges`;
- memory and PID limits;
- `expose` instead of `ports`, so nothing is published on the host.

## Configuration

Everything is configured through environment variables, validated at boot. A bad value stops the container with a message naming the variable. [`.env.example`](../.env.example) documents each one. For production:

| Variable | Required | Notes |
|---|---|---|
| `WEBHOOK_SECRET` | yes | `openssl rand -hex 32`. The Android app sends it as `X-Webhook-Secret`. |
| `BETTER_AUTH_SECRET` | yes | `openssl rand -hex 32`. Rotating it signs everyone out. |
| `DASHBOARD_ORIGIN` | yes* | The public origin, e.g. `https://budget.example.com`. |
| `BETTER_AUTH_URL` | yes* | The same public `https://` URL. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | Both are needed to enable the bot (see [usage](usage.md#telegram-bot)). |
| `OLLAMA_ENABLED`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS` | no | See [Ollama](#ollama-optional). |
| `TRUSTED_ORIGINS`, `APP_TIMEZONE`, `LOG_NOTIFICATION_TEXT` | no | Extra CORS/auth origins, month boundaries (default `Europe/Madrid`), raw-text logging (default off). |
| `COMPOSE_PROFILES`, `TUNNEL_TOKEN` | compose only | `COMPOSE_PROFILES=tunnel` starts cloudflared, which needs `TUNNEL_TOKEN`. |

\* At least one of `DASHBOARD_ORIGIN` and `BETTER_AUTH_URL` must be set in production, because localhost is never trusted there. Set both to the same URL.

The compose file itself sets `NODE_ENV=production`, `DATABASE_URL=/app/data/revbudget.db` and `TRUST_PROXY=true`, so the rate limiters key on Cloudflare's `cf-connecting-ip`. It also defaults `OLLAMA_URL` to `http://host.docker.internal:11434`.

## Local Docker (no tunnel)

Useful to try the production image on your machine. The native `bun run dev` loop in the [README](../README.md#quickstart) is still the better dev setup.

```bash
cp .env.example .env
# In .env:
#   - fill in both secrets: openssl rand -hex 32
#   - DASHBOARD_ORIGIN=http://localhost:3000
#   - BETTER_AUTH_URL=http://localhost:3000
#   - leave COMPOSE_PROFILES= blank, so cloudflared doesn't start

# Publish the port on loopback only. Compose picks this file up automatically,
# and it is gitignored.
cat > docker-compose.override.yml <<'EOF'
services:
  app:
    ports:
      - "127.0.0.1:3000:3000"
EOF

docker compose up -d --build
docker compose exec -u bun app bun /app/dist/create-admin.js --email you@example.com
```

Open <http://localhost:3000> and sign in. In production mode, session cookies are always `Secure`. Chrome and Firefox accept that on `http://localhost`, but not on a LAN IP over plain HTTP, so use `localhost` (or put TLS in front).

Run one-off commands with `-u bun`, as above. As root, the container has no `CAP_DAC_OVERRIDE`, so it couldn't write the database, and any files it did create would be owned by root.

## Docker Compose with Cloudflare Tunnel

1. In Cloudflare Zero Trust → **Networks → Tunnels**, create a tunnel and copy its connector token. Add a public hostname whose service is `http://app:3000`. `app` is the compose service name, resolved on the project network.
2. In `.env`, set:
   - `COMPOSE_PROFILES=tunnel`;
   - `TUNNEL_TOKEN=<token>`;
   - `DASHBOARD_ORIGIN` and `BETTER_AUTH_URL` to `https://<your-hostname>`.
3. Run:

   ```bash
   docker compose up -d --build
   ```

4. Point the Android app at `https://<your-hostname>/api/webhook/revolut` with your `WEBHOOK_SECRET`.

cloudflared makes only outbound connections, so the host needs no inbound firewall rules and no published ports. It is pinned by tag and digest, runs with `--no-autoupdate`, and reads its token from the `TUNNEL_TOKEN` environment variable rather than its command line, so other users on the host can't read it with `ps`. The app container gets `TUNNEL_TOKEN` blanked.

## Coolify

The compose file is built for Coolify with a Cloudflare Tunnel sidecar. Coolify's Traefik is bypassed, and no host ports leak.

1. **Application type:** *Docker Compose*. Use build context `.` and compose file `docker-compose.yml`.
2. **Environment:** the variables from [Configuration](#configuration), plus `COMPOSE_PROFILES=tunnel` and `TUNNEL_TOKEN`. For the first deploy only, you can add `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` (see [First admin](#first-admin)).
3. **Persistent storage:** mount `/app/data` on a Coolify-managed volume (or keep the default bind to the deployment directory).
4. **Domain / "Expose to internet":** leave it **disabled**. The cloudflared sidecar is the only ingress.
5. **Deployment strategy:** *Recreate*. The Telegram bot uses long polling, and Telegram answers `409 Conflict` when two instances poll the same token.
6. **Tunnel public hostname:** in Cloudflare, set the service URL to `http://app:3000`.

Coolify rebuilds on every push to the tracked branch. The layer cache keeps source-only rebuilds fast.

## First admin

Sign-up is disabled, so the first account has to be created out of band. Pick one:

- **CLI (recommended).** It prompts for the password without echoing it, so the password stays out of `ps` and shell history:

  ```bash
  bun run create-admin -- --email you@example.com                            # from a checkout
  docker compose exec -u bun app bun /app/dist/create-admin.js --email you@example.com   # in Docker
  ```

- **Boot-time bootstrap.** Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (≥ 12 characters). The server creates that admin on boot, but only if no users exist. Remove both variables after the first successful start.

After that, admins invite everyone else from the dashboard's **Users** page.

Never use `bun run db:seed:demo` for a deployment. Its admin password is published in the README, so it isn't bundled into the image and it refuses to run when `NODE_ENV=production` or when the configured origin isn't `localhost`.

## Ollama (optional)

When the deterministic parser can't read a notification, the server can ask a local [Ollama](https://ollama.com) model to normalize it. The model's answer is re-parsed and round-trip checked, and the resulting transaction always waits for human confirmation. Setup:

1. Run `ollama pull qwen2.5:3b` (or set `OLLAMA_MODEL`).
2. Leave `OLLAMA_ENABLED=true`, which is the default. Set it to `false` to skip the fallback entirely: unparseable notifications are then recorded as parse failures right away.
3. `OLLAMA_TIMEOUT_MS` (default 30000) bounds each call.

**Ollama has no authentication.** Anyone who can reach port 11434 can run prompts, pull or delete models, or swap the model this app relies on. Keep it on a private interface:

- **Same host, macOS or Windows (Docker Desktop):** the default `OLLAMA_URL=http://host.docker.internal:11434` just works with Ollama's default `127.0.0.1` binding.
- **Same host, Linux:** `host.docker.internal` resolves to the Docker bridge gateway (usually `172.17.0.1`), which Ollama's default `127.0.0.1` binding doesn't listen on. Bind Ollama to the bridge IP, **not** to `0.0.0.0`:

  ```bash
  docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'   # usually 172.17.0.1
  sudo systemctl edit ollama
  #   [Service]
  #   Environment="OLLAMA_HOST=172.17.0.1"
  sudo systemctl restart ollama
  ```

  If you have to bind more widely, firewall port 11434 so only the Docker networks can reach it. **Never expose `0.0.0.0:11434` on a host with a public interface.**
- **Another machine:** set `OLLAMA_URL` to its private address (LAN or VPN), never a public one.

## Data, migrations and backups

SQLite lives in `/app/data/revbudget.db` (`./data` on the host with the default compose file) in WAL mode. The entrypoint applies migrations on every start, then seeds the default wallets on first boot only, so deleting every wallet doesn't bring them back on restart.

```bash
# Consistent online backup (safe while the app is running)
sqlite3 data/revbudget.db ".backup 'revbudget-$(date +%F).db'"

# Re-run migrations by hand
docker compose exec -u bun app bun /app/dist/migrate.js
```

When wiping the database by hand, delete `revbudget.db*` as a set: the `-wal` and `-shm` files belong to it. A fresh file triggers the one-time seed on the next boot.

## Verifying a deployment

`scripts/qa-auth.ts` is a dependency-free HTTP client that checks a live deployment's auth setup from the outside:

- health and SPA responses;
- a 401 on every protected route;
- a JSON 404 on unknown API paths;
- CSP and CORP headers;
- sign-up disabled;
- login and cookie flags (`HttpOnly`, `Secure`, `SameSite`);
- the session and the admin role;
- CORS against a foreign origin;
- the webhook secret;
- server-side sign-out;
- the sign-in rate limit.

```bash
QA_BASE_URL=https://budget.example.com QA_ADMIN_EMAIL=you@example.com QA_ADMIN_PASSWORD='…' \
  bun run qa:auth
```

The `QA_*` variables can also live in `.env`. It exits non-zero if any check fails. The rate-limit check runs last and locks sign-in for about 60 seconds, so set `QA_SKIP_RATELIMIT=1` to skip it.

## Updating

```bash
git pull
docker compose up -d --build
```

On Coolify, this happens on every push. Migrations run automatically on start.

## Without Docker

```bash
bun install --frozen-lockfile
bun run build        # dashboard → dashboard/dist, server → dist/index.js
bun run db:migrate   # runs from source
bun run start        # NODE_ENV=production, serves the SPA and /api on $PORT
```

Put it behind a TLS-terminating proxy or tunnel. `BETTER_AUTH_URL` must be the public `https://` URL, and set `TRUST_PROXY=true` only when a proxy you control sets `cf-connecting-ip`.
