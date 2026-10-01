# RevBudget

Personal expense tracker powered by Revolut notifications. A companion Android app intercepts Revolut push notifications and POSTs them to this server's webhook. The server parses each notification, classifies the transaction against stored rules, and sends a Telegram message (with inline wallet buttons if classification is ambiguous). A Vue 3 dashboard visualizes wallets, transactions, rules, and stats.

## Stack

- **Bun** (runtime, package manager, test runner, bundler, `.env` loader)
- **Hono** + `@hono/zod-validator` + typed `hc<AppType>` RPC client
- **SQLite** via `bun:sqlite` + **Drizzle ORM** + `drizzle-kit` for migrations
- **Zod** for end-to-end validation (shared schemas in `/shared`)
- **Vue 3** + Vite + Tailwind v4 + Vue Router + Pinia + `@tanstack/vue-query` + `vue-echarts`
- **grammy** for the Telegram bot
- **Biome** for linting + formatting

## Layout

```
revbudget/
├── shared/     — Zod schemas + TS types shared between server and dashboard
├── server/     — Hono API, Drizzle DB, Telegram bot, notification parser
└── dashboard/  — Vue 3 SPA
```

## Setup

1. Install Bun (if missing): <https://bun.sh>
2. Install dependencies:
   ```bash
   bun install
   ```
3. Create `.env` at the repo root (copy from `.env.example`):
   ```bash
   cp .env.example .env
   ```
4. Generate a strong webhook secret:
   ```bash
   openssl rand -hex 32
   ```
   Paste it as `WEBHOOK_SECRET` in `.env`. The Android companion app must send the same value as the `X-Webhook-Secret` header.
5. Get a Telegram bot token from [@BotFather](https://t.me/BotFather) and paste it into `TELEGRAM_BOT_TOKEN`. Find your chat id by sending a message to the bot and curl-ing `https://api.telegram.org/bot<TOKEN>/getUpdates` — paste the numeric `chat.id` into `TELEGRAM_CHAT_ID`. The bot will silently drop any update that doesn't match this id. Use your **private chat** with the bot, never a group id — everyone in the chat could classify/ignore transactions.
6. Initialize the database:
   ```bash
   bun run db:generate   # first time only — migrations are already committed
   bun run db:migrate
   bun run db:seed       # inserts the 7 default wallets
   ```

## Authentication

The dashboard is gated by `better-auth` cookie sessions; the management API (`/api/wallets`, `/api/transactions`, `/api/merchant-rules`, `/api/stats`) requires a logged-in user. Invite-only — public sign-up is disabled. The Android-app webhook (`/api/webhook/revolut`) is unchanged: still gated by `WEBHOOK_SECRET` (machine-to-machine, no human user).

### First-run admin

Pick one:

```bash
# CLI (recommended — leaves no plaintext password in env, ps, or shell history;
# omit --password to type it at a hidden prompt)
bun run create-admin -- --email me@example.com --role admin
```

```bash
# Or boot-time env bootstrap (handy on Coolify's first deploy).
# Creates an admin only if no users exist; remove from env after first boot.
BOOTSTRAP_ADMIN_EMAIL=me@example.com
BOOTSTRAP_ADMIN_PASSWORD=...
```

### Inviting more users

Once an admin exists, log in and visit **/users** in the dashboard to add accounts. Each invitee is given a password by the admin; they should change it from their browser after first login.

### Env vars

| Variable | Purpose |
| -------- | ------- |
| `BETTER_AUTH_SECRET` | 32+ char random string. Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_URL` | Public URL where `/api/auth/*` is reachable. In production this is your tunnel hostname; **must use `https://`** so cookies get the `Secure` attribute. |
| `BOOTSTRAP_ADMIN_EMAIL` | Optional first-run admin email. |
| `BOOTSTRAP_ADMIN_PASSWORD` | Optional first-run admin password (≥ 12 chars). |

## Development

Start both server (port 3000) and dashboard (port 5173) with hot reload:
```bash
bun run dev
```

Or run them separately:
```bash
bun run dev:server      # Hono on :3000
bun run dev:dashboard   # Vite on :5173
```

The Vite dev server proxies `/api/*` to `http://localhost:3000`.

### Exposing the webhook to the Android app

Use ngrok (or equivalent) to expose the Hono server:
```bash
ngrok http 3000
```
Configure the Android app with the resulting URL + your `WEBHOOK_SECRET`. The webhook is at `POST /api/webhook/revolut`.

## Testing

```bash
bun test
```

The notification parser has 11+ test cases covering the Revolut Spanish notification variants, malformed input, trailing whitespace, non-breaking spaces, and thousands separators.

## Production

```bash
bun run build   # builds dashboard → dashboard/dist, then bundles server → dist/
bun run start   # boots Hono in production mode (serves dashboard/dist and /api/*)
```

In production, the Hono server serves the dashboard's static files via `hono/bun`'s `serveStatic` and mounts the API under `/api`.

## Docker

A multi-stage Dockerfile bundles the Hono server, builds the SPA, and ships everything as a single image. SQLite persists to a host bind-mount, the Telegram bot runs in-process via long polling, and a `cloudflared` sidecar (opt-in via the `tunnel` profile) exposes the webhook + dashboard publicly without opening host ports.

### One-time setup

```bash
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WEBHOOK_SECRET,
# BETTER_AUTH_SECRET, BETTER_AUTH_URL, DASHBOARD_ORIGIN
mkdir -p data
```

Auth uses cookie sessions managed by `better-auth` — no token is baked into the JS bundle, so the dashboard image is the same across deploys. Rotating `BETTER_AUTH_SECRET` invalidates all existing sessions but doesn't require a rebuild.

### Run with the Cloudflare Tunnel sidecar

1. Create a tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels), add a public hostname pointing to `http://app:3000`, and copy the connector token.
2. In `.env`: set `TUNNEL_TOKEN`, `COMPOSE_PROFILES=tunnel`, and `DASHBOARD_ORIGIN=https://<your-tunnel-host>`.
3. Bring everything up:
   ```bash
   docker compose up -d --build
   ```

The webhook is now reachable at `https://<your-tunnel-host>/api/webhook/revolut` — point the Android companion app there. ngrok is no longer needed.

### Run locally without the tunnel

The `app` service uses `expose: 3000`, not `ports:`, so the host port isn't published by default. To test the container without the tunnel:

```bash
# one-off port forward without editing the compose file
docker compose run --rm --service-ports -p 127.0.0.1:3000:3000 app
```

…or uncomment the `ports:` block in `docker-compose.yml`. The native `bun run dev` workflow remains the recommended dev loop.

### Deploy on Coolify (with Cloudflare Tunnel)

This compose was designed for the Coolify + Cloudflare Tunnel pattern: cloudflared is a sidecar of the app, Coolify's Traefik is bypassed, and no host ports leak.

In Coolify:

1. **Application type**: *Docker Compose*. Point at this repo / branch; build context `.`, compose file `docker-compose.yml`.
2. **Environment**: copy from `.env.example` — at minimum `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WEBHOOK_SECRET`, `BETTER_AUTH_SECRET` (32+ chars), `DASHBOARD_ORIGIN` (= `https://<your-tunnel-host>`), `BETTER_AUTH_URL` (same as `DASHBOARD_ORIGIN`), `TUNNEL_TOKEN`, and `COMPOSE_PROFILES=tunnel`. For first-run admin bootstrap, also set `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` for the initial deploy, then remove them. Skip `VITE_*` and `OLLAMA_URL` unless your Ollama isn't reachable from the Coolify host.
4. **Persistent storage**: mount `/app/data` to a Coolify-managed volume (or accept the default bind to the deployment dir). Backed up by Coolify between deploys.
5. **Domain / "Expose to internet"**: leave **disabled**. The cloudflared sidecar is the only public ingress; you don't want Coolify's Traefik fighting over the same service.
6. **Deployment strategy**: *Recreate* (kill the old container before starting the new one). The Telegram bot uses long polling, and Telegram returns `409 Conflict` if two instances poll the same token at once.
7. **Cloudflare Tunnel public hostname**: set the service URL in the Cloudflare dashboard to `http://app:3000` — `app` is the docker-compose service name and resolves over the project's internal network.

Coolify rebuilds on every git push; cached layers keep the rebuild under a minute when only source changes.

### Data persistence

The SQLite DB lives in `./data/revbudget.db` on the host. Migrations (and the idempotent wallet seed) run from the entrypoint on every container start. To inspect:

```bash
docker compose exec app bun /app/dist/migrate.js   # re-run migrations
sqlite3 data/revbudget.db ".tables"                # inspect from the host
```

### Ollama

By default the container points `OLLAMA_URL` at `http://host.docker.internal:11434` (works on macOS, Windows, and Linux via the `host-gateway` mapping). To disable the normalizer entirely, set `OLLAMA_ENABLED=false` in `.env`. To target a remote Ollama, override `OLLAMA_URL`.

### Updating

```bash
git pull
docker compose up -d --build
```

The build cache reuses unchanged layers so iterative builds are fast. On Coolify, the same happens automatically on every push to the tracked branch.

## Safety

- Env vars validated with Zod at boot (boot crashes on bad config)
- Dashboard / management API gated by `better-auth` cookie sessions; public sign-up disabled
- Sign-in rate-limited (5 attempts / 60s)
- Webhook shared-secret via `crypto.timingSafeEqual` (constant time)
- Telegram bot drops any update whose `chat.id` doesn't match `TELEGRAM_CHAT_ID`
- CORS locked to `DASHBOARD_ORIGIN` (no wildcards)
- `hono/secure-headers` on every route
- Token-bucket rate limiter on `/api/webhook/revolut` (60 req/min)
- All DB access via Drizzle query builder — no string SQL interpolation
- Global error handler returns `{ error, requestId }`, never stack traces
- `raw_text` is persisted but never logged; tokens and secrets are never logged
- `tsconfig` uses `strict` + `noUncheckedIndexedAccess`

## API

All routes below except `/api/auth/*`, `/api/webhook/*`, and `/api/health` require an authenticated session cookie (set by `POST /api/auth/sign-in/email`). Webhook ingest stays on `X-Webhook-Secret`.

| Method | Path                        | Notes                                           |
| ------ | --------------------------- | ----------------------------------------------- |
| POST   | `/api/auth/sign-in/email`   | Sets `better-auth.session_token` cookie         |
| POST   | `/api/auth/sign-out`        |                                                 |
| GET    | `/api/auth/get-session`     |                                                 |
| POST   | `/api/auth/admin/create-user` | Admin-only; invite/onboard another user       |
| POST   | `/api/webhook/revolut`      | Webhook ingest, requires `X-Webhook-Secret`     |
| GET    | `/api/wallets`              |                                                 |
| GET    | `/api/wallets/:id`          |                                                 |
| POST   | `/api/wallets`              |                                                 |
| PUT    | `/api/wallets/:id`          |                                                 |
| GET    | `/api/transactions`         | filters: `month`, `walletId`, `status`, `limit` |
| GET    | `/api/transactions/:id`     |                                                 |
| PUT    | `/api/transactions/:id`     | reclassification upserts a merchant rule        |
| DELETE | `/api/transactions/:id`     |                                                 |
| GET    | `/api/merchant-rules`       |                                                 |
| POST   | `/api/merchant-rules`       |                                                 |
| PUT    | `/api/merchant-rules/:id`   |                                                 |
| DELETE | `/api/merchant-rules/:id`   |                                                 |
| GET    | `/api/stats/monthly?month=` |                                                 |
| GET    | `/api/stats/trends`         | last 6 months per wallet + top 5 merchants      |

The full Hono app type is exported from `server/src/app.ts` as `AppType`, and consumed by the dashboard via `hc<AppType>(baseUrl)` — the frontend gets end-to-end type safety on every request.

## Telegram bot commands

- `/start` — welcome message
- `/status` — current month total + per-wallet progress
- `/wallets` — list of active wallets and budgets

When a notification arrives that has no matching rule, the bot sends a message with inline wallet buttons plus a 🚫 Ignore button. Tapping a wallet classifies the transaction and creates a `merchant_rules` entry so the next notification from the same merchant auto-classifies. Each classification gets a ↩️ Undo button that reverses the classification and deletes the rule.
