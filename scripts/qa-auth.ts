#!/usr/bin/env bun
/**
 * End-to-end authentication QA.
 *
 * Exercises the real auth flow (better-auth) against a live deployment, e.g.
 * the public host behind the Cloudflare Tunnel, checking what unit tests can't
 * see: the `Secure` cookie over HTTPS, CORS/trustedOrigins, protected and public
 * routes, disabled sign-up, the admin role, sign-out and the rate limit.
 *
 * It is a plain HTTP client: it imports nothing from `server/src` (that would
 * trigger config.ts's `process.exit(1)` on missing env) and is not bundled
 * into the image.
 *
 * Usage (pass the QA_* variables inline; Bun would also read them from `.env`, but
 * Docker Compose hands every .env entry to the app container):
 *   QA_BASE_URL=https://revbudget.example.com QA_ADMIN_EMAIL=… QA_ADMIN_PASSWORD=… bun run qa:auth
 *   bun scripts/qa-auth.ts --url https://host --email admin@example.com --password '…'
 *
 * Variables:
 *   QA_BASE_URL        public URL of the deployment, e.g. https://revbudget.example.com
 *   QA_ADMIN_EMAIL     email of an existing admin user
 *   QA_ADMIN_PASSWORD  their password
 *   QA_SKIP_RATELIMIT  =1 to skip the rate-limit check (it locks sign-in for ≤60s)
 *
 * Exits non-zero if any check fails (suitable for CI / post-deploy).
 */

type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
type Result = { status: Status; name: string };

const results: Result[] = [];

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const color = (code: number, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const paint: Record<Status, (s: string) => string> = {
  PASS: (s) => color(32, s),
  FAIL: (s) => color(31, s),
  WARN: (s) => color(33, s),
  SKIP: (s) => color(90, s),
};

function record(status: Status, name: string, detail = ''): void {
  results.push({ status, name });
  const tag = paint[status](status.padEnd(4));
  console.log(`  ${tag}  ${name}${detail ? color(90, ` — ${detail}`) : ''}`);
}
const pass = (n: string, d = ''): void => record('PASS', n, d);
const fail = (n: string, d = ''): void => record('FAIL', n, d);
const warn = (n: string, d = ''): void => record('WARN', n, d);
const skip = (n: string, d = ''): void => record('SKIP', n, d);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Config ──────────────────────────────────────────────────────────────────
function parseConfig(): {
  baseUrl: string;
  email: string;
  password: string;
  skipRateLimit: boolean;
} {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), 'true');
      }
    }
  }
  const skipEnv = process.env.QA_SKIP_RATELIMIT;
  return {
    baseUrl: (flags.get('url') ?? process.env.QA_BASE_URL ?? '').replace(/\/+$/, ''),
    email: flags.get('email') ?? process.env.QA_ADMIN_EMAIL ?? '',
    password: flags.get('password') ?? process.env.QA_ADMIN_PASSWORD ?? '',
    skipRateLimit: skipEnv === '1' || skipEnv === 'true' || flags.has('skip-ratelimit'),
  };
}

function printUsageAndExit(): never {
  console.error(`
${color(1, 'RevBudget — authentication QA')}

Missing credentials. Set these in .env (Bun autoloads it) or pass them as flags:

  QA_BASE_URL        public URL of the deployment, e.g. https://revbudget.example.com
  QA_ADMIN_EMAIL     email of an existing admin user
  QA_ADMIN_PASSWORD  their password

Examples:
  bun run qa:auth
  bun scripts/qa-auth.ts --url https://host --email admin@example.com --password '…'

Optional:
  QA_SKIP_RATELIMIT=1   skip the rate-limit check (it locks new sign-ins for ≤60s)
`);
  process.exit(2);
}

const { baseUrl, email, password, skipRateLimit } = parseConfig();
if (!baseUrl || !email || !password) printUsageAndExit();

// ── HTTP client + cookie jar ──────────────────────────────────────────────────
const jar = new Map<string, string>();

function readSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

function saveCookies(lines: string[]): void {
  for (const line of lines) {
    const first = line.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const deleted = value === '' || /(?:^|;)\s*max-age=0\b/i.test(line);
    if (deleted) jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

const findSessionCookie = (lines: string[]): string | undefined =>
  lines.find((c) => /session_token=[^;]/.test(c));

type Req = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  sendCookies?: boolean;
  saveToJar?: boolean;
};
type Res = { status: number; headers: Headers; setCookies: string[]; text: string; json: unknown };

async function call(path: string, req: Req = {}): Promise<Res> {
  const headers: Record<string, string> = { ...req.headers };
  // Behave like a browser: better-auth requires a trusted Origin (CSRF) on
  // authenticated actions such as sign-out. The CORS checks override it.
  if (headers.Origin === undefined) headers.Origin = baseUrl;
  let body: string | undefined;
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  if ((req.sendCookies ?? true) && jar.size > 0 && headers.Cookie === undefined) {
    headers.Cookie = cookieHeader();
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: req.method ?? 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const setCookies = readSetCookies(res);
  if (req.saveToJar ?? true) saveCookies(setCookies);
  return { status: res.status, headers: res.headers, setCookies, text, json };
}

// ── Checks ────────────────────────────────────────────────────────────────────
console.log(`\n${color(1, 'RevBudget — authentication QA')}  ${color(90, baseUrl)}`);
console.log(color(90, `  admin: ${email}\n`));

// 1. HTTPS
if (baseUrl.startsWith('https://')) {
  pass('URL is https');
} else {
  warn('URL is not https', 'the tunnel should serve https; the Secure cookie cannot be verified');
}

// 2. Health
try {
  const r = await call('/api/health', { sendCookies: false });
  if (r.status === 200 && isRecord(r.json) && r.json.ok === true) {
    pass('GET /api/health', '200 { ok: true }');
  } else {
    fail('GET /api/health', `status ${r.status}, body ${r.text.slice(0, 120)}`);
  }
} catch (e) {
  fail('GET /api/health', `could not connect: ${errMsg(e)}`);
}

// 3. SPA served
try {
  const r = await call('/', { sendCookies: false });
  const ct = r.headers.get('content-type') ?? '';
  if (r.status === 200 && ct.includes('text/html')) {
    pass('GET / (SPA)', `200 ${ct.split(';')[0]}`);
  } else {
    warn('GET / (SPA)', `status ${r.status}, content-type ${ct || 'n/a'}`);
  }
} catch (e) {
  fail('GET / (SPA)', errMsg(e));
}

// 4. Protected routes without a session → 401
for (const p of [
  '/api/wallets',
  '/api/transactions',
  '/api/merchant-rules',
  '/api/stats/monthly',
]) {
  try {
    const r = await call(p, { sendCookies: false });
    const body = isRecord(r.json) ? r.json : {};
    if (r.status === 401 && body.error === 'unauthorized') {
      pass(`401 without session ${p}`);
    } else {
      fail(`401 without session ${p}`, `status ${r.status}, body ${r.text.slice(0, 120)}`);
    }
  } catch (e) {
    fail(`401 without session ${p}`, errMsg(e));
  }
}

// 4b. Unknown API route → JSON 404, not the SPA with a 200
try {
  const r = await call('/api/qa-nonexistent-path', { sendCookies: false });
  const ct = r.headers.get('content-type') ?? '';
  const body = isRecord(r.json) ? r.json : {};
  if (r.status === 404 && ct.includes('application/json') && body.error === 'not_found') {
    pass('JSON 404 on unknown /api/*');
  } else {
    fail(
      'JSON 404 on unknown /api/*',
      `status ${r.status}, content-type ${ct || 'n/a'}, body ${r.text.slice(0, 120)}`,
    );
  }
} catch (e) {
  fail('JSON 404 on unknown /api/*', errMsg(e));
}

// 4c. Security headers on the SPA (prod-only CSP + default CORP)
try {
  const r = await call('/', { sendCookies: false });
  const csp = r.headers.get('content-security-policy');
  const corp = r.headers.get('cross-origin-resource-policy');
  if (csp?.includes("default-src 'self'")) {
    pass('CSP present on /', `${csp.slice(0, 60)}…`);
  } else {
    fail('CSP present on /', csp ?? 'header missing');
  }
  if (corp === 'same-origin') {
    pass('CORP same-origin');
  } else {
    warn('CORP same-origin', corp ?? 'header missing');
  }
} catch (e) {
  fail('Security headers on /', errMsg(e));
}

// 5. Sign-up disabled (invite-only)
try {
  const probe = `qa-signup-${Date.now()}-${Math.floor(Math.random() * 1e6)}@qa.invalid`;
  const r = await call('/api/auth/sign-up/email', {
    method: 'POST',
    body: { email: probe, password: 'qa-temp-password-123', name: 'QA Probe' },
    sendCookies: false,
    saveToJar: false,
  });
  const createdSession = Boolean(findSessionCookie(r.setCookies));
  if (r.status >= 400 && !createdSession) {
    pass('sign-up disabled', `rejected with ${r.status}`);
  } else {
    fail(
      'sign-up disabled',
      `status ${r.status}${createdSession ? ' + created a session' : ''} — invite-only is broken!`,
    );
  }
} catch (e) {
  fail('sign-up disabled', errMsg(e));
}

// 6. Valid login → 200 + session cookie (sign-in hit #1)
let loggedIn = false;
try {
  const r = await call('/api/auth/sign-in/email', { method: 'POST', body: { email, password } });
  if (r.status === 429) {
    warn('login admin', 'rate-limited (429) — wait ~60s and retry; skipping the session checks');
  } else if (r.status !== 200) {
    fail('login admin', `status ${r.status}, body ${r.text.slice(0, 160)}`);
  } else {
    const cookieLine = findSessionCookie(r.setCookies);
    if (!cookieLine) {
      fail('login admin', '200 but no session cookie in Set-Cookie');
    } else {
      loggedIn = true;
      const name = cookieLine.split('=')[0] ?? 'cookie';
      const attrs = cookieLine.split(';').map((s) => s.trim().toLowerCase());
      const hasHttpOnly = attrs.includes('httponly');
      const hasSecure = attrs.includes('secure');
      const sameSite =
        attrs.find((a) => a.startsWith('samesite='))?.split('=')[1] ?? '(no SameSite)';
      pass('login admin', `200 + cookie ${name}`);
      if (hasHttpOnly) pass('cookie HttpOnly');
      else fail('cookie HttpOnly', `${name} without HttpOnly — readable from JS (XSS risk)`);
      if (!baseUrl.startsWith('https://')) {
        skip('cookie Secure', 'base URL is not https');
      } else if (hasSecure) {
        pass('cookie Secure', 'flag present over https');
      } else {
        fail(
          'cookie Secure',
          'NO Secure over https — the browser will drop it. Set BETTER_AUTH_URL=https://<tunnel-host>',
        );
      }
      pass('cookie SameSite', sameSite);
    }
  }
} catch (e) {
  fail('login admin', errMsg(e));
}

// 7. get-session → admin user
if (loggedIn) {
  try {
    const r = await call('/api/auth/get-session');
    const user = isRecord(r.json) && isRecord(r.json.user) ? r.json.user : undefined;
    const sameEmail =
      typeof user?.email === 'string' && user.email.toLowerCase() === email.toLowerCase();
    if (r.status === 200 && sameEmail) {
      const role = typeof user?.role === 'string' ? user.role : '(no role)';
      if (role === 'admin') pass('get-session', `${email} (admin)`);
      else warn('get-session', `session OK but role = ${role} (expected admin)`);
    } else {
      fail('get-session', `status ${r.status}, body ${r.text.slice(0, 120)}`);
    }
  } catch (e) {
    fail('get-session', errMsg(e));
  }
} else {
  skip('get-session', 'not logged in');
}

// 8. Protected routes with a session → 200
if (loggedIn) {
  for (const p of ['/api/wallets', '/api/stats/monthly']) {
    try {
      const r = await call(p);
      if (r.status === 200) pass(`200 with session ${p}`);
      else fail(`200 with session ${p}`, `status ${r.status}`);
    } catch (e) {
      fail(`200 with session ${p}`, errMsg(e));
    }
  }
} else {
  skip('protected routes with session', 'not logged in');
}

// 9. Admin endpoint (admin plugin)
if (loggedIn) {
  try {
    const r = await call('/api/auth/admin/list-users?limit=1');
    if (r.status === 200) pass('admin list-users', '200 (admin role enforced server-side)');
    else if (r.status === 403)
      fail('admin list-users', '403 — the user is not an admin server-side');
    else warn('admin list-users', `status ${r.status} (different admin plugin endpoint?)`);
  } catch (e) {
    fail('admin list-users', errMsg(e));
  }
} else {
  skip('admin list-users', 'not logged in');
}

// 10. CORS / trustedOrigins
try {
  const evil = 'https://evil.example.com';
  const rTrusted = await call('/api/health', { headers: { Origin: baseUrl }, sendCookies: false });
  const rEvil = await call('/api/health', { headers: { Origin: evil }, sendCookies: false });
  const acaoTrusted = rTrusted.headers.get('access-control-allow-origin');
  const acaoEvil = rEvil.headers.get('access-control-allow-origin');
  if (acaoEvil === evil) {
    fail('CORS untrusted origin', `ACAO reflected ${evil} — trustedOrigins is too permissive`);
  } else {
    pass('CORS untrusted origin', `not reflected (ACAO=${acaoEvil ?? 'absent'})`);
  }
  if (acaoTrusted === baseUrl) {
    pass('CORS trusted origin', `ACAO=${acaoTrusted}`);
  } else {
    warn(
      'CORS trusted origin',
      `ACAO=${acaoTrusted ?? 'absent'} — does DASHBOARD_ORIGIN/TRUSTED_ORIGINS include ${baseUrl}?`,
    );
  }
} catch (e) {
  fail('CORS', errMsg(e));
}

// 11. Webhook still requires the secret
try {
  const r = await call('/api/webhook/revolut', {
    method: 'POST',
    body: { text: 'qa probe' },
    sendCookies: false,
    saveToJar: false,
  });
  if (r.status === 401 || r.status === 403)
    pass('webhook without secret', `rejected with ${r.status}`);
  else fail('webhook without secret', `status ${r.status} — it should require X-Webhook-Secret!`);
} catch (e) {
  fail('webhook without secret', errMsg(e));
}

// 12. Login with a wrong password → 401 (sign-in hit #2)
try {
  const r = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email, password: 'definitely-wrong-qa-password' },
    sendCookies: false,
    saveToJar: false,
  });
  if (r.status === 401) pass('login with wrong password', '401');
  else if (r.status === 429)
    warn('login with wrong password', 'rate-limited (429) before validation');
  else fail('login with wrong password', `status ${r.status} (expected 401)`);
} catch (e) {
  fail('login with wrong password', errMsg(e));
}

// 13. Sign-out invalidates the session server-side
if (loggedIn) {
  try {
    const sessionCookie = cookieHeader(); // authenticated snapshot
    const out = await call('/api/auth/sign-out', { method: 'POST' });
    const reuse = await call('/api/wallets', {
      sendCookies: false,
      headers: { Cookie: sessionCookie },
    });
    if (out.status === 200 && reuse.status === 401) {
      pass('sign-out invalidates session', 'reusing the cookie → 401');
    } else {
      fail('sign-out invalidates session', `sign-out ${out.status}, reuse ${reuse.status}`);
    }
  } catch (e) {
    fail('sign-out invalidates session', errMsg(e));
  }
} else {
  skip('sign-out', 'not logged in');
}

// 14. Rate limit (last: locks new sign-ins for ≤60s)
if (skipRateLimit) {
  skip('rate-limit', 'QA_SKIP_RATELIMIT is set');
} else {
  try {
    console.log(color(90, '  … burst of sign-ins (will lock new sign-ins for ~60s)'));
    let got429 = false;
    let attempts = 0;
    for (let i = 0; i < 8 && !got429; i++) {
      attempts++;
      const r = await call('/api/auth/sign-in/email', {
        method: 'POST',
        body: { email, password: 'definitely-wrong-qa-password' },
        sendCookies: false,
        saveToJar: false,
      });
      if (r.status === 429) got429 = true;
    }
    if (got429) pass('rate-limit', `429 after ${attempts} attempts`);
    else warn('rate-limit', 'no 429 in 8 attempts (rate limit disabled?)');
  } catch (e) {
    fail('rate-limit', errMsg(e));
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────
const counts: Record<Status, number> = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
for (const r of results) counts[r.status]++;

console.log(
  `\n${color(1, 'Summary')}: ${paint.PASS(`${counts.PASS} PASS`)}  ${paint.FAIL(
    `${counts.FAIL} FAIL`,
  )}  ${paint.WARN(`${counts.WARN} WARN`)}  ${paint.SKIP(`${counts.SKIP} SKIP`)}`,
);

if (counts.FAIL > 0) {
  console.log(`${paint.FAIL('✗ QA failed.')}\n`);
  process.exit(1);
}
console.log(`${paint.PASS('✓ QA passed.')}\n`);
process.exit(0);
