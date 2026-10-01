import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { currentMonth, formatDateTime, monthBounds, shiftMonth } from 'shared';
import { config } from '../config';
import { auth } from '../lib/auth';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { monthlySummary } from '../services/stats';
import { ensureMigrated, truncateAll, truncateAuth } from '../test/db';
import { db } from './index';
import { merchantRules, transactions, user, wallets } from './schema';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemo } from './seed-demo';

const originalNodeEnv = config.NODE_ENV;
const originalAuthUrl = config.BETTER_AUTH_URL;
const originalTrustedOrigins = config.trustedOrigins;

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
});

beforeEach(async () => {
  await truncateAll();
  await truncateAuth();
});

afterEach(() => {
  config.DEMO_MODE = false;
  (config as { NODE_ENV: string }).NODE_ENV = originalNodeEnv;
  (config as { BETTER_AUTH_URL?: string }).BETTER_AUTH_URL = originalAuthUrl;
  config.trustedOrigins = originalTrustedOrigins;
});

async function roleOf(email: string) {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.email, email));
  return row?.role;
}

describe('seedDemo', () => {
  // Mid-month, and at, one second and five minutes into a month (Madrid time):
  // a demo resets at midnight, when the current month has no elapsed time to
  // hold its transactions.
  test.each([
    '2026-09-15T10:00:00.000Z',
    '2026-09-30T22:00:00.000Z',
    '2026-09-30T22:00:01.000Z',
    '2026-09-30T22:05:00.000Z',
  ])('builds a current-looking demo (now = %s)', async (iso) => {
    const now = new Date(iso);
    const report = await seedDemo(now);
    expect(report).toContain(`demo admin created: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);

    const walletRows = await db.select().from(wallets);
    expect(walletRows.map((w) => w.name).sort()).toEqual(
      ['Entertainment', 'Food', 'Health', 'Home', 'Other', 'Subscriptions', 'Transport'].sort(),
    );

    // Six months, ending now: nothing in the future, nothing older.
    const month = currentMonth(now, config.APP_TIMEZONE);
    const oldest = monthBounds(shiftMonth(month, -5), config.APP_TIMEZONE)?.startISO ?? '';
    const months = new Set(
      (await db.select().from(transactions)).map((t) =>
        currentMonth(new Date(t.transactionDate), config.APP_TIMEZONE),
      ),
    );
    expect(months.size).toBe(6);
    const txs = await db.select().from(transactions);
    for (const t of txs) {
      expect(t.transactionDate >= oldest && t.transactionDate <= now.toISOString()).toBe(true);
    }

    const count = (pred: (t: (typeof txs)[number]) => boolean) => txs.filter(pred).length;
    expect(count((t) => t.status === 'pending' && t.walletId === null)).toBe(4);
    expect(count((t) => t.status === 'pending_confirmation' && t.walletId !== null)).toBe(2);
    expect(count((t) => t.type === 'income')).toBeGreaterThan(0);
    const byId = new Map(txs.map((t) => [t.id, t]));
    for (const type of ['refund', 'adjustment'] as const) {
      const linked = txs.filter((t) => t.type === type);
      expect(linked.length).toBe(1);
      expect(byId.get(linked[0]?.relatedTxId ?? -1)?.type).toBe('expense');
    }

    // Every budget bar lands between 40% and 110%, in all three colours.
    const summary = await monthlySummary(month);
    const pcts = summary.perWallet.map((w) => (w.spent / w.budget) * 100);
    expect(pcts.length).toBe(7);
    for (const pct of pcts) expect(pct >= 40 && pct <= 110).toBe(true);
    expect(pcts.some((p) => p < 70)).toBe(true);
    expect(pcts.some((p) => p >= 70 && p < 90)).toBe(true);
    expect(pcts.some((p) => p >= 90)).toBe(true);

    const rules = await db.select().from(merchantRules);
    expect(rules.length).toBe(5);
    expect(new Set(rules.map((r) => r.matchType))).toEqual(new Set(['exact', 'contains']));
    expect(rules.some((r) => r.requireConfirmation)).toBe(true);

    const signIn = await auth.api.signInEmail({
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    expect(signIn.user.email).toBe(DEMO_EMAIL);
    expect(await roleOf(DEMO_EMAIL)).toBe('admin');
  });

  // Rows planned for the same day shared a timestamp, and in a 31-day month
  // every row sat at 12:00.
  test('spreads transactions over their days', async () => {
    await seedDemo(new Date('2026-09-15T10:00:00.000Z'));
    const dates = (await db.select().from(transactions)).map((t) => t.transactionDate);
    expect(new Set(dates).size).toBe(dates.length);
    const july = dates.filter((d) => currentMonth(new Date(d), config.APP_TIMEZONE) === '2026-07');
    const times = new Set(july.map((d) => formatDateTime(d).slice(-5)));
    expect(times.size).toBeGreaterThan(july.length / 2);
  });

  test('DEMO_MODE seeds a production config with a public origin, and a plain user', async () => {
    config.DEMO_MODE = true;
    (config as { NODE_ENV: string }).NODE_ENV = 'production';
    (config as { BETTER_AUTH_URL?: string }).BETTER_AUTH_URL = 'https://demo.example.com';
    expect(await seedDemo()).toContain(`demo user created: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    expect(await roleOf(DEMO_EMAIL)).toBe('user');
    expect((await db.select().from(transactions)).length).toBeGreaterThan(0);
  });

  test('locally, adds no demo admin to a database that already has users', async () => {
    await auth.api.createUser({
      body: { email: 'owner@example.com', password: 'owner-password-123', name: 'Owner' },
    });
    expect(await seedDemo()).toContain(
      'users already exist: sign in with your own account (no demo admin created)',
    );
    expect((await db.select().from(user)).map((u) => u.email)).toEqual(['owner@example.com']);
  });

  test('ensures the demo user by email, next to other users', async () => {
    await auth.api.createUser({
      body: { email: 'owner@example.com', password: 'owner-password-123', name: 'Owner' },
    });
    config.DEMO_MODE = true;
    expect(await seedDemo()).toContain(`demo user created: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    await truncateAll();
    expect(await seedDemo()).toContain(`demo user already exists: ${DEMO_EMAIL}`);
    expect((await db.select().from(user)).map((u) => u.email).sort()).toEqual([
      DEMO_EMAIL,
      'owner@example.com',
    ]);
  });

  test('refuses a database that already has transactions', async () => {
    await seedDemo();
    await expect(seedDemo()).rejects.toThrow(/already has \d+ transactions/);
  });

  test('refuses to run in production', async () => {
    (config as { NODE_ENV: string }).NODE_ENV = 'production';
    await expect(seedDemo()).rejects.toThrow(/NODE_ENV=production/);
    expect(await db.select().from(wallets)).toEqual([]);
  });

  // A host checkout has no NODE_ENV, but a production .env names its public origin.
  test('refuses a config that points at a public origin', async () => {
    (config as { BETTER_AUTH_URL?: string }).BETTER_AUTH_URL = 'https://budget.example.com';
    await expect(seedDemo()).rejects.toThrow(/budget\.example\.com/);
    expect(await db.select().from(wallets)).toEqual([]);
  });

  test('refuses a public host among the TRUSTED_ORIGINS', async () => {
    config.trustedOrigins = [...originalTrustedOrigins, 'https://budget.example.com'];
    await expect(seedDemo()).rejects.toThrow(/budget\.example\.com/);
    expect(await db.select().from(wallets)).toEqual([]);
  });

  test("allows a developer's LAN address among the TRUSTED_ORIGINS", async () => {
    config.trustedOrigins = [...originalTrustedOrigins, 'http://192.168.1.20:5173'];
    expect(await seedDemo()).toContain(`demo admin created: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  });
});

describe('bun server/src/db/seed-demo.ts', () => {
  test('works on a freshly migrated database and refuses a second run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'revbudget-demo-'));
    const env = { ...process.env, DATABASE_URL: join(dir, 'demo.db') };
    const run = (script: string) =>
      Bun.spawnSync([process.execPath, resolve(import.meta.dir, script)], { env });

    expect(run('migrate.ts').exitCode).toBe(0);
    const first = run('seed-demo.ts');
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain(`${DEMO_EMAIL} / ${DEMO_PASSWORD}`);

    const second = run('seed-demo.ts');
    expect(second.exitCode).toBe(1);
    expect(second.stderr.toString()).toContain('refusing to run');
  });
});
