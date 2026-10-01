#!/usr/bin/env bun
/**
 * QA end-to-end de autenticación — rama feat/auth.
 *
 * Ejercita el flujo real de auth (better-auth 1.6.9) contra el despliegue
 * público detrás del túnel Cloudflare, validando lo que los tests unitarios no
 * pueden ver: cookie `Secure` sobre HTTPS, CORS/trustedOrigins, rutas
 * protegidas/públicas, sign-up deshabilitado, rol admin, sign-out y rate-limit.
 *
 * Es un cliente HTTP puro: NO importa nada de `server/src` (eso dispararía el
 * `process.exit(1)` de config.ts por env faltante) y no se bundlea en la imagen.
 *
 * Uso (Bun autocarga `.env`, así que basta con definir las QA_* ahí):
 *   bun scripts/qa-auth.ts
 *   bun scripts/qa-auth.ts --url https://host --email admin@x.com --password '…'
 *
 * Variables:
 *   QA_BASE_URL        URL pública del túnel, p.ej. https://revbudget.tu-dominio.com
 *   QA_ADMIN_EMAIL     email de un usuario admin existente
 *   QA_ADMIN_PASSWORD  su contraseña
 *   QA_SKIP_RATELIMIT  =1 para omitir el test de rate-limit (bloquea logins ≤60s)
 *
 * Sale con código ≠0 si algún check falla (apto para CI / post-deploy).
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
${color(1, 'RevBudget — QA de autenticación (rama feat/auth)')}

Faltan credenciales. Definí estas variables en .env (Bun las autocarga) o pasalas por flag:

  QA_BASE_URL        URL pública del túnel, p.ej. https://revbudget.tu-dominio.com
  QA_ADMIN_EMAIL     email de un usuario admin existente
  QA_ADMIN_PASSWORD  su contraseña

Ejemplos:
  bun scripts/qa-auth.ts
  bun scripts/qa-auth.ts --url https://host --email admin@x.com --password '…'

Opcional:
  QA_SKIP_RATELIMIT=1   omite el test de rate-limit (que bloquea nuevos logins ≤60s)
`);
  process.exit(2);
}

const { baseUrl, email, password, skipRateLimit } = parseConfig();
if (!baseUrl || !email || !password) printUsageAndExit();

// ── Cliente HTTP + cookie jar ─────────────────────────────────────────────────
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
  // Simula al navegador: better-auth exige un Origin de confianza (CSRF) en las
  // acciones autenticadas como sign-out. Los tests de CORS lo sobreescriben.
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
console.log(`\n${color(1, 'RevBudget — QA de autenticación')}  ${color(90, baseUrl)}`);
console.log(color(90, `  admin: ${email}\n`));

// 1. HTTPS
if (baseUrl.startsWith('https://')) {
  pass('URL es https');
} else {
  warn('URL no es https', 'el túnel debería servir https; la cookie Secure no se podrá validar');
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
  fail('GET /api/health', `no se pudo conectar: ${errMsg(e)}`);
}

// 3. SPA servida
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

// 4. Rutas protegidas sin sesión → 401
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
      pass(`401 sin sesión ${p}`);
    } else {
      fail(`401 sin sesión ${p}`, `status ${r.status}, body ${r.text.slice(0, 120)}`);
    }
  } catch (e) {
    fail(`401 sin sesión ${p}`, errMsg(e));
  }
}

// 4b. Ruta API desconocida → 404 JSON, no la SPA con 200
try {
  const r = await call('/api/qa-nonexistent-path', { sendCookies: false });
  const ct = r.headers.get('content-type') ?? '';
  const body = isRecord(r.json) ? r.json : {};
  if (r.status === 404 && ct.includes('application/json') && body.error === 'not_found') {
    pass('404 JSON en /api/* desconocido');
  } else {
    fail(
      '404 JSON en /api/* desconocido',
      `status ${r.status}, content-type ${ct || 'n/a'}, body ${r.text.slice(0, 120)}`,
    );
  }
} catch (e) {
  fail('404 JSON en /api/* desconocido', errMsg(e));
}

// 4c. Cabeceras de seguridad en la SPA (CSP prod-only + CORP por defecto)
try {
  const r = await call('/', { sendCookies: false });
  const csp = r.headers.get('content-security-policy');
  const corp = r.headers.get('cross-origin-resource-policy');
  if (csp?.includes("default-src 'self'")) {
    pass('CSP presente en /', `${csp.slice(0, 60)}…`);
  } else {
    fail('CSP presente en /', csp ?? 'cabecera ausente');
  }
  if (corp === 'same-origin') {
    pass('CORP same-origin');
  } else {
    warn('CORP same-origin', corp ?? 'cabecera ausente');
  }
} catch (e) {
  fail('Cabeceras de seguridad en /', errMsg(e));
}

// 5. Sign-up deshabilitado (invite-only)
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
    pass('sign-up deshabilitado', `rechazado con ${r.status}`);
  } else {
    fail(
      'sign-up deshabilitado',
      `status ${r.status}${createdSession ? ' + creó sesión' : ''} — ¡invite-only roto!`,
    );
  }
} catch (e) {
  fail('sign-up deshabilitado', errMsg(e));
}

// 6. Login correcto → 200 + cookie de sesión (sign-in hit #1)
let loggedIn = false;
try {
  const r = await call('/api/auth/sign-in/email', { method: 'POST', body: { email, password } });
  if (r.status === 429) {
    warn(
      'login admin',
      'rate-limited (429) — esperá ~60s y reintentá; se omiten los checks con sesión',
    );
  } else if (r.status !== 200) {
    fail('login admin', `status ${r.status}, body ${r.text.slice(0, 160)}`);
  } else {
    const cookieLine = findSessionCookie(r.setCookies);
    if (!cookieLine) {
      fail('login admin', '200 pero sin cookie de sesión en Set-Cookie');
    } else {
      loggedIn = true;
      const name = cookieLine.split('=')[0] ?? 'cookie';
      const attrs = cookieLine.split(';').map((s) => s.trim().toLowerCase());
      const hasHttpOnly = attrs.includes('httponly');
      const hasSecure = attrs.includes('secure');
      const sameSite =
        attrs.find((a) => a.startsWith('samesite='))?.split('=')[1] ?? '(sin SameSite)';
      pass('login admin', `200 + cookie ${name}`);
      if (hasHttpOnly) pass('cookie HttpOnly');
      else fail('cookie HttpOnly', `${name} sin HttpOnly — accesible vía JS (riesgo XSS)`);
      if (!baseUrl.startsWith('https://')) {
        skip('cookie Secure', 'base no es https');
      } else if (hasSecure) {
        pass('cookie Secure', 'flag presente sobre https');
      } else {
        fail(
          'cookie Secure',
          'SIN Secure sobre https — el navegador la descartará. Poné BETTER_AUTH_URL=https://<host-túnel>',
        );
      }
      pass('cookie SameSite', sameSite);
    }
  }
} catch (e) {
  fail('login admin', errMsg(e));
}

// 7. get-session → usuario admin
if (loggedIn) {
  try {
    const r = await call('/api/auth/get-session');
    const user = isRecord(r.json) && isRecord(r.json.user) ? r.json.user : undefined;
    const sameEmail =
      typeof user?.email === 'string' && user.email.toLowerCase() === email.toLowerCase();
    if (r.status === 200 && sameEmail) {
      const role = typeof user?.role === 'string' ? user.role : '(sin rol)';
      if (role === 'admin') pass('get-session', `${email} (admin)`);
      else warn('get-session', `sesión OK pero rol = ${role} (esperaba admin)`);
    } else {
      fail('get-session', `status ${r.status}, body ${r.text.slice(0, 120)}`);
    }
  } catch (e) {
    fail('get-session', errMsg(e));
  }
} else {
  skip('get-session', 'sin login');
}

// 8. Rutas protegidas con sesión → 200
if (loggedIn) {
  for (const p of ['/api/wallets', '/api/stats/monthly']) {
    try {
      const r = await call(p);
      if (r.status === 200) pass(`200 con sesión ${p}`);
      else fail(`200 con sesión ${p}`, `status ${r.status}`);
    } catch (e) {
      fail(`200 con sesión ${p}`, errMsg(e));
    }
  }
} else {
  skip('rutas protegidas con sesión', 'sin login');
}

// 9. Endpoint admin (plugin admin)
if (loggedIn) {
  try {
    const r = await call('/api/auth/admin/list-users?limit=1');
    if (r.status === 200) pass('admin list-users', '200 (rol admin server-side)');
    else if (r.status === 403) fail('admin list-users', '403 — el usuario no es admin server-side');
    else warn('admin list-users', `status ${r.status} (¿endpoint del plugin admin distinto?)`);
  } catch (e) {
    fail('admin list-users', errMsg(e));
  }
} else {
  skip('admin list-users', 'sin login');
}

// 10. CORS / trustedOrigins
try {
  const evil = 'https://evil.example.com';
  const rTrusted = await call('/api/health', { headers: { Origin: baseUrl }, sendCookies: false });
  const rEvil = await call('/api/health', { headers: { Origin: evil }, sendCookies: false });
  const acaoTrusted = rTrusted.headers.get('access-control-allow-origin');
  const acaoEvil = rEvil.headers.get('access-control-allow-origin');
  if (acaoEvil === evil) {
    fail('CORS origen no confiable', `ACAO reflejó ${evil} — trustedOrigins demasiado abierto`);
  } else {
    pass('CORS origen no confiable', `no reflejado (ACAO=${acaoEvil ?? 'ausente'})`);
  }
  if (acaoTrusted === baseUrl) {
    pass('CORS origen confiable', `ACAO=${acaoTrusted}`);
  } else {
    warn(
      'CORS origen confiable',
      `ACAO=${acaoTrusted ?? 'ausente'} — ¿DASHBOARD_ORIGIN/TRUSTED_ORIGINS incluye ${baseUrl}?`,
    );
  }
} catch (e) {
  fail('CORS', errMsg(e));
}

// 11. Webhook sigue exigiendo el secret
try {
  const r = await call('/api/webhook/revolut', {
    method: 'POST',
    body: { text: 'qa probe' },
    sendCookies: false,
    saveToJar: false,
  });
  if (r.status === 401 || r.status === 403) pass('webhook sin secret', `rechazado con ${r.status}`);
  else fail('webhook sin secret', `status ${r.status} — ¡debería exigir X-Webhook-Secret!`);
} catch (e) {
  fail('webhook sin secret', errMsg(e));
}

// 12. Login con password incorrecta → 401 (sign-in hit #2)
try {
  const r = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email, password: 'definitely-wrong-qa-password' },
    sendCookies: false,
    saveToJar: false,
  });
  if (r.status === 401) pass('login password incorrecta', '401');
  else if (r.status === 429)
    warn('login password incorrecta', 'rate-limited (429) antes de validar');
  else fail('login password incorrecta', `status ${r.status} (esperaba 401)`);
} catch (e) {
  fail('login password incorrecta', errMsg(e));
}

// 13. Sign-out invalida la sesión server-side
if (loggedIn) {
  try {
    const sessionCookie = cookieHeader(); // snapshot autenticado
    const out = await call('/api/auth/sign-out', { method: 'POST' });
    const reuse = await call('/api/wallets', {
      sendCookies: false,
      headers: { Cookie: sessionCookie },
    });
    if (out.status === 200 && reuse.status === 401) {
      pass('sign-out invalida sesión', 'reusar la cookie → 401');
    } else {
      fail('sign-out invalida sesión', `sign-out ${out.status}, reuso ${reuse.status}`);
    }
  } catch (e) {
    fail('sign-out invalida sesión', errMsg(e));
  }
} else {
  skip('sign-out', 'sin login');
}

// 14. Rate-limit (último: bloquea nuevos logins ≤60s)
if (skipRateLimit) {
  skip('rate-limit', 'QA_SKIP_RATELIMIT activo');
} else {
  try {
    console.log(color(90, '  … ráfaga de sign-ins (bloqueará nuevos logins ~60s)'));
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
    if (got429) pass('rate-limit', `429 tras ${attempts} intentos`);
    else warn('rate-limit', 'nunca devolvió 429 en 8 intentos (¿rate-limit desactivado?)');
  } catch (e) {
    fail('rate-limit', errMsg(e));
  }
}

// ── Resumen ────────────────────────────────────────────────────────────────────
const counts: Record<Status, number> = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
for (const r of results) counts[r.status]++;

console.log(
  `\n${color(1, 'Resumen')}: ${paint.PASS(`${counts.PASS} PASS`)}  ${paint.FAIL(
    `${counts.FAIL} FAIL`,
  )}  ${paint.WARN(`${counts.WARN} WARN`)}  ${paint.SKIP(`${counts.SKIP} SKIP`)}`,
);

if (counts.FAIL > 0) {
  console.log(`${paint.FAIL('✗ QA con fallos.')}\n`);
  process.exit(1);
}
console.log(`${paint.PASS('✓ QA OK.')}\n`);
process.exit(0);
