import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { user } from '../db/schema';
import { ensureMigrated } from '../test/db';
import { auth } from './auth';

const EMAIL = 'auth-cookie-test@example.com';
const PASSWORD = 'auth-cookie-password-123';

// Signs a fresh user in and prints the session Set-Cookie header.
const signInScript = (email: string) => `
  const { runMigrations } = await import(${JSON.stringify(join(import.meta.dir, '../db/migrate.ts'))});
  const { db } = await import(${JSON.stringify(join(import.meta.dir, '../db/index.ts'))});
  runMigrations(db);
  const { auth } = await import(${JSON.stringify(join(import.meta.dir, 'auth.ts'))});
  const body = { email: ${JSON.stringify(email)}, password: ${JSON.stringify(PASSWORD)} };
  await auth.api.createUser({ body: { ...body, name: 'Cookie Test' } });
  const res = await auth.api.signInEmail({ body, asResponse: true });
  console.log(res.headers.get('set-cookie'));
`;

// Failed sign-ins through the app as Bun would serve it (see index.ts): six
// from one socket, each claiming a different client IP, then one from another
// socket. Prints the statuses.
const rotatingSignInScript = `
  const { runMigrations } = await import(${JSON.stringify(join(import.meta.dir, '../db/migrate.ts'))});
  const { db } = await import(${JSON.stringify(join(import.meta.dir, '../db/index.ts'))});
  runMigrations(db);
  const { app } = await import(${JSON.stringify(join(import.meta.dir, '../app.ts'))});
  const signIn = async (socketIp, claimedIp) => {
    const req = new Request('http://budget.lan/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://budget.lan',
        'X-Forwarded-For': claimedIp,
        'X-Revbudget-Client-Ip': claimedIp,
      },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-123' }),
    });
    const server = { requestIP: () => ({ address: socketIp, family: 'IPv4', port: 1 }) };
    return (await app.fetch(req, server)).status;
  };
  const statuses = [];
  for (let i = 1; i <= 6; i++) statuses.push(await signIn('203.0.113.9', '198.51.100.' + i));
  statuses.push(await signIn('203.0.113.10', '198.51.100.1'));
  console.log(JSON.stringify(statuses));
  process.exit(0);
`;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await db.delete(user).where(eq(user.email, EMAIL));
});

describe('session cookie', () => {
  test('expires after 7 days', async () => {
    await auth.api.createUser({ body: { email: EMAIL, password: PASSWORD, name: 'Cookie Test' } });
    const res = await auth.api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      asResponse: true,
    });
    expect(res.headers.get('set-cookie')).toContain(`Max-Age=${7 * 24 * 60 * 60};`);
  });

  // A fresh process: auth.ts reads NODE_ENV from config once, at import.
  test.each([
    ['in production even when the base URL is http', 'production', 'http://budget.lan'],
    ['outside production when the base URL is https', 'development', 'https://budget.lan'],
  ])('is Secure %s', (_, nodeEnv, baseUrl) => {
    const dir = mkdtempSync(join(tmpdir(), 'revbudget-auth-'));
    try {
      const proc = Bun.spawnSync([process.execPath, '-e', signInScript(EMAIL)], {
        cwd: dir,
        env: {
          ...process.env,
          NODE_ENV: nodeEnv,
          BETTER_AUTH_URL: baseUrl,
          DASHBOARD_ORIGIN: baseUrl,
          DATABASE_URL: join(dir, 'auth.db'),
        },
      });
      const setCookie = proc.stdout.toString();
      expect(proc.exitCode).toBe(0);
      expect(setCookie).toContain('__Secure-better-auth.session_token=');
      expect(setCookie).toMatch(/;\s*Secure/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sign-in rate limit', () => {
  // Production-only limiter, so a fresh process (see the cookie tests above).
  test('keys on the socket address without TRUST_PROXY, not on x-forwarded-for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'revbudget-auth-'));
    try {
      const proc = Bun.spawnSync([process.execPath, '-e', rotatingSignInScript], {
        cwd: dir,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          TRUST_PROXY: 'false',
          BETTER_AUTH_URL: 'http://budget.lan',
          DASHBOARD_ORIGIN: 'http://budget.lan',
          DATABASE_URL: join(dir, 'auth.db'),
        },
      });
      expect(proc.exitCode).toBe(0);
      const statuses = JSON.parse(proc.stdout.toString().trim().split('\n').at(-1) ?? '');
      // 5 per minute on /sign-in/email (lib/auth.ts customRules), per socket.
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 401]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
