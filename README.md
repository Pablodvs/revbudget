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
5. Get a Telegram bot token from [@BotFather](https://t.me/BotFather) and paste it into `TELEGRAM_BOT_TOKEN`. Find your chat id by sending a message to the bot and curl-ing `https://api.telegram.org/bot<TOKEN>/getUpdates` — paste the numeric `chat.id` into `TELEGRAM_CHAT_ID`. The bot will silently drop any update that doesn't match this id.
6. Initialize the database:
   ```bash
   bun run db:generate   # first time only — migrations are already committed
   bun run db:migrate
   bun run db:seed       # inserts the 7 default wallets
   ```

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

## Safety

- Env vars validated with Zod at boot (boot crashes on bad config)
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

| Method | Path                        | Notes                                           |
| ------ | --------------------------- | ----------------------------------------------- |
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
