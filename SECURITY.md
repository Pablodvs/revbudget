# Security Policy

## Supported versions

Only `master` is supported. There are no release branches, and fixes land on `master`.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **private vulnerability reporting**: open the repository's **Security** tab and click **Report a vulnerability**. Please don't open a public issue or pull request for a security problem.

A useful report includes the affected commit, steps to reproduce and the impact you expect. I'll acknowledge it, keep you updated in the advisory thread, and credit you in the fix unless you'd rather not be named.

## Threat model

RevBudget is a single-tenant, invite-only personal finance app. It runs as one container, and its only ingress from the internet is a Cloudflare Tunnel.

### Crown jewels

- **Transaction history.** Merchants, amounts and raw notification text are financial PII.
- **User sessions.** Any signed-in user can read and change all the data.
- **Secrets:** `BETTER_AUTH_SECRET`, `WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN` and `TUNNEL_TOKEN`.
- **Ledger integrity.** Budgets and stats are only worth something if the amounts are right.

### Trust boundaries

| Boundary | Who is on the other side | Authenticated by | Key controls |
|---|---|---|---|
| Internet → Cloudflare Tunnel → app | Anyone | None | No published host ports; security headers and CSP on every response |
| Dashboard and management API (`/api/*`) | Invited users' browsers | better-auth session cookie | Sign-up disabled, Origin check, `SameSite=Lax`, sign-in rate limit |
| Webhook (`POST /api/webhook/revolut`) | The Android companion app | `X-Webhook-Secret` (timing-safe compare) | Per-IP rate limit before the secret check, Zod-validated body, linear-time parser |
| Telegram bot | Telegram (outbound long polling) | Chat-id allowlist | Checked on every update including button callbacks; callback data parsed with anchored patterns and re-read from the DB |
| LLM fallback (Ollama) | A model on a private network | Network isolation only | Output treated as untrusted: re-parsed, round-trip checked, and always sent for human confirmation |
| Container → host | The app process | n/a | Non-root, `cap_drop: ALL`, `no-new-privileges`, app code read-only for the runtime user, memory and PID limits |

**Out of scope:** a compromised phone or Revolut account, Cloudflare itself, and isolation *between* users. That last one is deliberate: see the authorization model below.

### Authorization model

Accounts are invite-only, and public sign-up is disabled. **Any signed-in user has full read/write access to all wallets, transactions and rules.** The `admin` role only gates user management (inviting, banning and removing users), and better-auth's admin plugin enforces it server-side. The app is single-tenant by design, so invite only people you would show your bank statements to.

### Public demo

The public demo runs the same code with `DEMO_MODE=true` and publishes its login, so anyone can sign in ([setup](docs/deploy.md#public-demo-instance-coolify--github-app)). These controls contain it:

- **A separate instance.** It has its own container, database, secrets and Cloudflare Tunnel, so nothing it holds or accepts works against prod.
- **It can't run on real data.** A database only counts as a demo if it holds the demo account, which is created only on an empty database. With `DEMO_MODE` on and transactions but no demo account, the server refuses to start, and the reset refuses too, so a mistyped env var or a shared volume can't cap, lock or wipe real data.
- **Fake data only.** Everything in it is seeded or typed in by visitors.
- **A shared, non-admin login.** `demo@example.com` / `revbudget-demo` has the `user` role, so it can't manage users.
- **Account changes blocked by an allowlist.** Under `/api/auth/*`, only `POST sign-in/email`, `POST sign-out` and `GET get-session` get through. Anything else, such as a password change that would lock every other visitor out, answers 403 `demo_locked`. An allowlist fails closed, so an endpoint added by a better-auth upgrade is blocked too.
- **No Telegram.** The server refuses to start with `DEMO_MODE` and Telegram configured, so the demo can't reach a real chat.
- **No Ollama.** `OLLAMA_ENABLED` is forced to `false`, so public input never reaches a model.
- **A session-bound, rate-limited simulator.** `POST /api/demo/notifications` exists only in demo mode, needs a signed-in session and accepts at most 500 characters. It feeds the same linear-time parser as the webhook, without needing the webhook secret.
- **Bounded writes.** In demo mode, mutating API calls are rate-limited per client IP, and hard caps on transactions, parse failures, wallets and rules hold even against many IPs. Past a cap, creating answers 403 `demo_full` until the reset. That keeps both the dashboard's queries and the reset fast.
- **A nightly reset.** At midnight `APP_TIMEZONE`, when the dashboard's month can roll over, all data and sessions are wiped and the demo is seeded again.

Remaining risks, accepted:

- **Vandalism until the reset.** Any visitor can rename, delete or fill the shared data up to its caps, and everyone sees it until the next reset (or a [manual one](docs/deploy.md#reset-the-demo)). The data is fake and the damage lasts a day at most. What visitors type is rendered as text, never HTML, and the production CSP backs that up.
- **A shared host.** The demo runs next to prod. `mem_limit`, `pids_limit` and `APP_CPUS=1` cap its memory, processes and CPU, and it has the same container hardening. The write caps bound its database, so a flood can't fill the disk prod writes to. It can still use its one CPU and share the host's network, which is a nuisance rather than a data risk, and stopping the demo in Coolify ends it without touching prod.

## Controls summary

- **Sessions:** better-auth cookie sessions: `HttpOnly`, `SameSite=Lax`, `Secure` with the `__Secure-` prefix in production, and a 7-day expiry. Banning or removing a user revokes their sessions immediately.
- **Sign-in:** limited to 5 attempts per minute per IP, with no account enumeration.
- **CORS and CSRF:** an exact-match origin allowlist (`DASHBOARD_ORIGIN`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`), with localhost never trusted in production. better-auth checks the Origin header, and the custom routes are JSON-only.
- **Webhook:**
  - A token bucket (60 requests/min per IP, idle entries evicted, IPv6 keyed by /64) runs *before* the constant-time secret check.
  - The client IP comes from `cf-connecting-ip` only when `TRUST_PROXY=true`.
- **Input handling:**
  - Every route is Zod-validated, and `/api/*` has a 64 KB body limit.
  - Money is integer cents, bounded at €1,000,000.
  - The notification regexes are linear-time, with a ReDoS regression test.
  - The database enforces CHECK and UNIQUE constraints.
  - Queries go through Drizzle's query builder, with no raw SQL.
- **Errors and logs:**
  - Errors return `{ error, issues?, requestId }`, and 5xx responses are always generic.
  - Logs are redacted. Raw notification text is logged only when `LOG_NOTIFICATION_TEXT=true`.
- **HTTP headers:**
  - A strict production CSP (its one relaxation, `style-src 'unsafe-inline'`, is needed by vue-echarts).
  - HSTS, `nosniff`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and CORP `same-origin`.
  - `Cache-Control: no-store` on `/api/*`.
- **Configuration:**
  - Environment variables are validated at boot, and the app refuses to start on bad config.
  - Secrets must be at least 32 characters, and known placeholder values (`generate_with…`) are rejected.
- **LLM fallback:**
  - The Ollama URL and model come from config only, so there's no SSRF.
  - Requests have hard timeouts and capped output.
  - A model's extraction is accepted only if the deterministic parser reproduces it exactly.
- **Container and infrastructure:**
  - The tunnel is the only ingress.
  - Base images are pinned by digest, and installs use the frozen lockfile.
  - `tini` is PID 1.
  - The runtime user can write only `/app/data`.
  - The tunnel token reaches cloudflared via the environment (not argv) and is blanked in the app container.
- **Supply chain:** CI on every pull request and push to master, GitHub Actions pinned by commit SHA, and weekly Dependabot updates.

## Dependency advisories

`bun audit` flags advisories in the dependency tree. The 2026-09-30 review took it from 61 advisories (1 critical, 24 high) to 24 (15 high, 9 moderate) by bumping better-auth to 1.6.33 and hono to 4.13.12, and by replacing the frozen `@better-auth/cli` 1.4 with its successor `auth` 1.6.33, which was the source of the critical. None of the fixed ones was reachable in this app. What `bun audit` still reports, and why it doesn't apply:

| Package | Advisory | Why it isn't reachable here |
|---|---|---|
| `drizzle-orm` < 0.45.2 | SQL injection via improperly escaped identifiers ([GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9)) | Identifiers are static schema columns. No user input becomes an identifier, and there's no `sql.raw` or `sql.identifier`. The major bump is deferred. |
| `echarts` < 6.1.0 | XSS in the `lines` series ([GHSA-fgmj-fm8m-jvvx](https://github.com/advisories/GHSA-fgmj-fm8m-jvvx)) | Only the Bar and Line charts are registered (tree-shaken `echarts/core`), so the `lines` series isn't bundled. Merchant names never reach ECharts. The major bump is deferred. |
| `lodash`, `browserslist`, `baseline-browser-mapping` | Various | Only pulled in by the `auth` schema-generation CLI, a dev dependency that isn't in the image. |
| `vite`, `esbuild`, `postcss`, `nanoid`, `brace-expansion` | Dev-server and build-time issues | Build and dev tooling only. None of it runs in the production image. |

Run `bun audit` for the current list. A new advisory in a package that ships in the server bundle or the SPA gets triaged here.

## Security reviews

Past reviews, their findings and how each one was resolved are in [`docs/security/`](docs/security/).
