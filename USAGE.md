# RevBudget — Setup & Usage Guide

A walkthrough for getting RevBudget running locally and using it day to day. For an architectural reference, see `README.md`.

---

## Part 1 — Setup

### Prerequisites

- **Bun** ≥ 1.1 — install from <https://bun.sh>
- A **Telegram account** and a bot created via [@BotFather](https://t.me/BotFather)
- The **Android companion app** installed on your phone (intercepts Revolut notifications)
- **ngrok** (or any tunnel) to expose your local server to the Android app

### 1. Clone & install

```bash
git clone <repo-url> revbudget
cd revbudget
bun install
```

`bun install` resolves the three workspaces (`shared`, `server`, `dashboard`) in one pass.

### 2. Configure environment

Copy the example file and fill it in:

```bash
cp .env.example .env
```

Then edit `.env`:

| Variable | What to put |
|---|---|
| `PORT` | `3000` (default) |
| `DATABASE_URL` | `./data/revbudget.db` (default — file is created on first migrate) |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather after `/newbot` |
| `TELEGRAM_CHAT_ID` | Your numeric Telegram chat id (see below) |
| `WEBHOOK_SECRET` | Output of `openssl rand -hex 32` |
| `DASHBOARD_ORIGIN` | `http://localhost:5173` for dev |

**Generate a strong webhook secret:**

```bash
openssl rand -hex 32
```

**Find your Telegram chat id:**

1. Send any message to your new bot in Telegram.
2. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser.
3. Copy the numeric `chat.id` from the JSON.

The bot will silently drop any update from a different chat id — this is single-user software. `TELEGRAM_CHAT_ID` must be your **private chat** with the bot, never a group id: anyone in that chat can classify and ignore transactions.

### 3. Initialize the database

```bash
bun run db:migrate    # applies the committed migrations
bun run db:seed       # inserts the 7 default wallets
```

After this you should have a `data/revbudget.db` file with seeded wallets (Food, Transport, Entertainment, Subscriptions, Home, Health, Other).

### 4. Start the dev servers

```bash
bun run dev
```

This boots:

- **Hono API** on `http://localhost:3000`
- **Vite dashboard** on `http://localhost:5173`

Open <http://localhost:5173> in your browser — you should see the Overview view with the seeded wallets and zero transactions.

### 5. Expose the webhook to your phone

In a separate terminal:

```bash
ngrok http 3000
```

Copy the HTTPS forwarding URL ngrok prints (e.g. `https://abc123.ngrok-free.app`) and configure the Android companion app with:

- **Webhook URL:** `<ngrok-url>/api/webhook/revolut`
- **Secret header:** `X-Webhook-Secret: <your WEBHOOK_SECRET>`

The Android app will now POST every Revolut notification it intercepts to your local server.

---

## Part 2 — Daily Usage

### The flow at a glance

```
Revolut push → Android app → POST /api/webhook/revolut
                                    │
                                    ▼
                          Parse amount + merchant
                                    │
                          ┌─────────┴─────────┐
                          ▼                   ▼
                  rule exists?          no rule
                          │                   │
                          ▼                   ▼
                Auto-classify       Telegram message
                Telegram confirm    with wallet buttons
                                            │
                                            ▼
                                    User taps wallet
                                            │
                                            ▼
                          Classify + create merchant_rule
                          (next time auto-classifies)
```

### Using the Telegram bot

When a transaction arrives with **no matching rule**, the bot DMs you something like:

> 💳 **LIDL CENTRAL** — 12,50 €
>
> [🍕 Food] [🚗 Transport]
> [🎮 Entertainment] [📱 Subscriptions]
> [🏠 Home] [💊 Health]
> [📦 Other] [🚫 Ignore]

Tap a wallet:

- The transaction is classified into that wallet.
- A `merchant_rules` row is upserted: `lidl central → Food`. Next time LIDL CENTRAL charges you, it auto-classifies and the bot just sends a confirmation.
- The message is edited to `✅ LIDL CENTRAL → Food 🍕` with an `↩️ Undo` button.

Tap **🚫 Ignore** to mark the transaction as ignored (it stays in the DB but doesn't count toward any budget).

Tap **↩️ Undo** to reverse the last classification and delete the rule it created.

**Bot commands you can send manually:**

| Command | What it does |
|---|---|
| `/start` | Welcome message |
| `/status` | Current month total + per-wallet progress vs. budget |
| `/wallets` | List of active wallets and their budgets |

### Using the dashboard

Open <http://localhost:5173>.

**Overview (`/`)** — your home view.
- Header shows the current month with `←` `→` arrows to scrub through months.
- A grid of wallet cards with progress bars (green < 70%, yellow 70–90%, red > 90%).
- A total summary card and the latest 5 transactions across all wallets.
- Click any wallet card → its detail view.

**Wallet Detail (`/wallet/:id`)**
- Shows the full transaction list for the selected month in that wallet.
- A cumulative spending line chart for the month.
- An **Edit wallet** button to change name, budget, color, or icon.

**Transactions (`/transactions`)**
- A filterable table of all transactions (filter by month, wallet, or status).
- Pending transactions are flagged with a badge.
- Click a row to open the edit modal: change wallet, amount, or description.
- Reclassifying a transaction also updates/creates the corresponding merchant rule, so the change "sticks" for future notifications from that merchant.

**Rules (`/rules`)**
- Table of every `merchant → wallet` rule.
- Edit the target wallet, delete a rule, or create one manually (useful for pre-classifying a merchant before the first charge arrives).

**Stats (`/stats`)**
- Bar chart of spending per wallet for the current month.
- Line chart of the last 6 months trend per wallet.
- Top 5 merchants by total spending.

### Common tasks

**Add a new wallet**
Use the Overview view's "New wallet" action (or `POST /api/wallets`). Choose a name, monthly budget (entered in your currency, stored in cents), color, and optional emoji icon.

**Change a wallet's monthly budget**
Wallet Detail → **Edit wallet**. Updates apply from the current month forward.

**Move a transaction to a different wallet**
Transactions view → click the row → pick a new wallet in the modal. The matching merchant rule is updated automatically so future charges follow.

**Pre-classify a merchant before the first charge**
Rules view → **New rule** → enter the normalized merchant string (lowercase, single-spaced) and target wallet. Use `match_type: contains` if Revolut sends slightly different merchant strings each time.

**Inspect the database directly**
```bash
bun run db:studio
```
Opens Drizzle Studio in the browser.

**Run the test suite**
```bash
bun test
```

---

## Part 3 — Production

Build the dashboard and bundle the server:

```bash
bun run build
bun run start
```

In production, the Hono server serves `dashboard/dist` as static files and mounts `/api/*` on the same port — no separate Vite process. Set `NODE_ENV=production` and a production-appropriate `DASHBOARD_ORIGIN` in `.env`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server crashes at boot with a Zod error | A required env var in `.env` is missing or malformed. The error message names the field. |
| Webhook returns `401` | `X-Webhook-Secret` header missing or doesn't match `WEBHOOK_SECRET`. |
| Webhook returns `429` | Token-bucket rate limit hit (60 req/min). The Android app is sending too fast. |
| Bot doesn't respond | `TELEGRAM_CHAT_ID` doesn't match the chat you're messaging from. The bot drops unknown chats silently — check the value. |
| Dashboard shows "Network error" | API not running on `:3000`, or `DASHBOARD_ORIGIN` doesn't match what the dashboard is served from (CORS). |
| Notification arrives but is `pending` with `parse_failed` | The notification text doesn't match any regex in `server/src/services/notification-parser.ts`. Add a new matcher and a test case. |
| `db:migrate` fails | Delete `data/revbudget.db` (dev only!) and re-run `db:migrate` + `db:seed`. |
