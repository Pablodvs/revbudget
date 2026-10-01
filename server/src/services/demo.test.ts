import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { currentMonth } from 'shared';
import { config } from '../config';
import { db } from '../db';
import {
  account,
  merchantRules,
  parseFailures,
  session,
  transactions,
  user,
  wallets,
} from '../db/schema';
import { seedWalletRows } from '../db/seed';
import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_SAMPLES, seedDemo } from '../db/seed-demo';
import { auth } from '../lib/auth';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { ensureMigrated, seedWallet, truncateAll, truncateAuth } from '../test/db';
import { invalidateContainsCache } from './classifier';
import {
  NotADemoDatabaseError,
  nextResetAt,
  resetDemo,
  scheduleDemoReset,
  seedDemoIfEmpty,
} from './demo';
import { ingestNotification } from './ingest';
import * as telegram from './telegram';

// A demo never has Telegram (config refuses it), but this suite's config has
// the preload's fake bot: keep it unreached.
spyOn(telegram, 'sendClassifyPrompt').mockResolvedValue(null);
spyOn(telegram, 'sendConfirmRulePrompt').mockResolvedValue(null);
spyOn(telegram, 'sendParseFailedPrompt').mockResolvedValue(null);
spyOn(telegram, 'sendConfirmation').mockResolvedValue(undefined);

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
  mock.restore();
});

beforeEach(async () => {
  await truncateAll();
  await truncateAuth();
  invalidateContainsCache();
  config.DEMO_MODE = true;
});

afterEach(() => {
  config.DEMO_MODE = false;
});

// Everything a visitor sees, without the ids and timestamps a reseed renews.
async function demoState() {
  const walletRows = await db.select().from(wallets);
  const walletName = new Map(walletRows.map((w) => [w.id, w.name]));
  const txs = await db.select().from(transactions);
  const merchantOf = new Map(txs.map((t) => [t.id, t.merchant]));
  const sorted = <T>(rows: T[]) => rows.map((r) => JSON.stringify(r)).sort();
  return {
    wallets: sorted(
      walletRows.map(({ name, budget, color, icon, isActive }) => ({
        name,
        budget,
        color,
        icon,
        isActive,
      })),
    ),
    transactions: sorted(
      txs.map((t) => ({
        wallet: t.walletId === null ? null : walletName.get(t.walletId),
        amount: t.amount,
        merchant: t.merchant,
        status: t.status,
        type: t.type,
        related: t.relatedTxId === null ? null : merchantOf.get(t.relatedTxId),
        transactionDate: t.transactionDate,
      })),
    ),
    rules: sorted(
      (await db.select().from(merchantRules)).map((r) => ({
        pattern: r.pattern,
        wallet: walletName.get(r.walletId),
        matchType: r.matchType,
        requireConfirmation: r.requireConfirmation,
      })),
    ),
    parseFailures: (await db.select().from(parseFailures)).length,
  };
}

describe('seedDemoIfEmpty', () => {
  test("seeds a fresh database, topping up the entrypoint's default wallets", async () => {
    await db.insert(wallets).values(seedWalletRows());
    const info = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await seedDemoIfEmpty();
      expect(info.mock.calls.some(([line]) => String(line).includes('demo_seeded'))).toBe(true);
    } finally {
      info.mockRestore();
    }
    expect((await db.select().from(wallets)).length).toBe(7);
    expect((await db.select().from(transactions)).length).toBeGreaterThan(0);
    const [demoUser] = await db.select().from(user).where(eq(user.email, DEMO_EMAIL));
    expect(demoUser?.role).toBe('user');
  });

  // Without the demo account it's DEMO_MODE on a real database, by mistake:
  // the server refuses to run rather than cap, lock or reset real data.
  test('refuses a database with transactions that is no demo', async () => {
    const wallet = await seedWallet();
    await db.insert(transactions).values({
      walletId: wallet.id,
      amount: 100,
      currency: 'EUR',
      merchant: 'shop',
      merchantDisplay: 'Shop',
      rawText: 'x',
      status: 'classified',
      transactionDate: new Date().toISOString(),
    });
    await expect(seedDemoIfEmpty()).rejects.toBeInstanceOf(NotADemoDatabaseError);
    expect((await db.select().from(transactions)).length).toBe(1);
    expect(await db.select().from(user)).toEqual([]);

    // A demo's restart.
    await truncateAll();
    await seedDemo(new Date('2026-09-15T10:00:00.000Z'));
    await expect(seedDemoIfEmpty()).resolves.toBeUndefined();
  });

  // The whole boot path, in a fresh process: it must exit, not serve.
  test('the server exits when DEMO_MODE is on a real database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'revbudget-demo-boot-'));
    try {
      const env = { ...process.env, DATABASE_URL: join(dir, 'real.db') };
      const run = (script: string, extra: Record<string, string> = {}) =>
        Bun.spawnSync([process.execPath, '-e', script], {
          env: { ...env, ...extra },
          timeout: 20_000,
        });
      const src = (file: string) => JSON.stringify(join(import.meta.dir, '..', file));
      // A real database: migrated, one wallet and one transaction, no demo user.
      const setup = run(`
        const { db } = await import(${src('db/index.ts')});
        const { runMigrations } = await import(${src('db/migrate.ts')});
        const { transactions, wallets } = await import(${src('db/schema.ts')});
        runMigrations(db, ${src('db/migrations')});
        const w = db.insert(wallets).values({ name: 'Real', budget: 1000, color: '#10b981' }).returning().get();
        db.insert(transactions).values({ walletId: w.id, amount: 100, merchant: 'shop',
          merchantDisplay: 'Shop', rawText: 'x', status: 'classified',
          transactionDate: new Date().toISOString() }).run();
      `);
      expect(setup.exitCode).toBe(0);
      // No Telegram (a demo refuses it), so only the database check can stop it.
      const boot = run(`await import(${src('index.ts')});`, {
        DEMO_MODE: 'true',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
      });
      const output = boot.stderr.toString() + boot.stdout.toString();
      expect(output).toContain('this database has transactions and no demo@example.com user');
      expect(boot.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resetDemo', () => {
  test('puts a visited demo back as seeded, signing everyone out but keeping users', async () => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    await seedDemo(now);
    await auth.api.createUser({
      body: { email: 'owner@example.com', password: 'owner-password-123', name: 'Owner' },
    });
    const seeded = await demoState();
    const tesco = DEMO_SAMPLES.find((s) => s.id === 'known-merchant');
    if (!tesco) throw new Error('known-merchant sample missing');

    // A visitor's day: an edited rule (now in the classifier's cache), new
    // transactions, a parse failure, a deleted and a new wallet, a session.
    await db
      .update(merchantRules)
      .set({ requireConfirmation: true })
      .where(eq(merchantRules.pattern, 'tesco'));
    invalidateContainsCache();
    expect((await ingestNotification(tesco.text, now, 'test')).status).toBe('pending_confirmation');
    for (const sample of DEMO_SAMPLES) await ingestNotification(sample.text, now, 'test');
    await db.delete(wallets).where(eq(wallets.name, 'Health'));
    await seedWallet({ name: 'Holidays' });
    await auth.api.signInEmail({ body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    expect((await db.select().from(session)).length).toBe(1);
    expect(await demoState()).not.toEqual(seeded);

    await resetDemo(now);

    expect(await demoState()).toEqual(seeded);
    expect(await db.select().from(session)).toEqual([]);
    expect((await db.select().from(user)).map((u) => u.email).sort()).toEqual([
      DEMO_EMAIL,
      'owner@example.com',
    ]);
    // The classifier forgot the edited rule along with the rest.
    expect((await ingestNotification(tesco.text, now, 'test')).status).toBe('classified');
  });

  // DEMO_MODE set on a real database by mistake: its owner, their data and
  // their session, but no demo account.
  test('refuses a database without the demo account, deleting nothing', async () => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    await auth.api.createUser({
      body: { email: 'owner@example.com', password: 'owner-password-123', name: 'Owner' },
    });
    config.DEMO_MODE = false;
    expect(await seedDemo(now)).toContain(
      'users already exist: sign in with your own account (no demo admin created)',
    );
    config.DEMO_MODE = true;
    await ingestNotification('Your card ending 4821 was used online', now, 'test');
    await auth.api.signInEmail({
      body: { email: 'owner@example.com', password: 'owner-password-123' },
    });
    const everything = async () => ({
      ...(await demoState()),
      users: await db.select().from(user),
      sessions: await db.select().from(session),
    });
    const before = await everything();
    expect(before.transactions.length).toBeGreaterThan(0);
    expect(before.sessions.length).toBe(1);

    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await resetDemo(now);
      expect(error.mock.calls.map(([line]) => String(line))).toEqual([
        expect.stringContaining('demo_reset_refused'),
      ]);
    } finally {
      error.mockRestore();
    }
    expect(await everything()).toEqual(before);
  });

  test('a failed reseed keeps the old demo, and its account', async () => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    await seedDemo(now);
    const seeded = await demoState();
    const demoUser = async () => db.select().from(user).where(eq(user.email, DEMO_EMAIL));
    const account = await demoUser();
    await expect(resetDemo(new Date('invalid'))).rejects.toThrow();
    expect(await demoState()).toEqual(seeded);
    expect(await demoUser()).toEqual(account);
  });

  // Changed past the auth lock (a bypass, or an owner's admin): the published
  // login must not stay broken.
  test('restores the demo account as published', async () => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    await seedDemo(now);
    const [demo] = await db.select().from(user).where(eq(user.email, DEMO_EMAIL));
    if (!demo) throw new Error('demo user missing');
    const ctx = await auth.$context;
    await db
      .update(account)
      .set({ password: await ctx.password.hash('taken-over-123') })
      .where(eq(account.userId, demo.id));
    await db
      .update(user)
      .set({ name: 'Taken over', role: 'admin', banned: true })
      .where(eq(user.id, demo.id));
    const signIn = () =>
      auth.api.signInEmail({ body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    await expect(signIn()).rejects.toThrow();

    await resetDemo(now);

    expect((await signIn()).user.email).toBe(DEMO_EMAIL);
    const [restored] = await db.select().from(user).where(eq(user.email, DEMO_EMAIL));
    expect(restored).toMatchObject({ name: 'Demo', role: 'user', banned: false });
    expect(await db.select().from(account)).toHaveLength(1);
  });

  // Each deleted row's referencers are looked up by related_tx_id. Unindexed,
  // wiping a flooded demo was quadratic (16k rows took 31 s, blocking the server).
  test('wipes a flooded ledger quickly', async () => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    await seedDemo(now);
    const w = await seedWallet();
    const row = {
      walletId: w.id,
      amount: 100,
      merchant: 'flood',
      merchantDisplay: 'Flood',
      rawText: 'x',
      status: 'classified' as const,
      type: 'expense' as const,
      transactionDate: now.toISOString(),
    };
    db.transaction((t) => {
      for (let i = 0; i < 8000; i++) t.insert(transactions).values(row).run();
    });
    const start = performance.now();
    await resetDemo(now);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('nextResetAt', () => {
  test.each([
    // Madrid (CEST, +2): tonight's midnight, or tomorrow's once it has come.
    ['2026-09-30T10:00:00.000Z', 'Europe/Madrid', '2026-09-30T22:00:00.000Z'],
    ['2026-09-30T21:59:59.999Z', 'Europe/Madrid', '2026-09-30T22:00:00.000Z'],
    ['2026-09-30T22:00:00.000Z', 'Europe/Madrid', '2026-10-01T22:00:00.000Z'],
    // DST ends 25 Oct 2026 at 03:00 CEST: that night's midnight is still CEST,
    // the next one CET (+1), also from 00:30 CEST, before the change.
    ['2026-10-24T12:00:00.000Z', 'Europe/Madrid', '2026-10-24T22:00:00.000Z'],
    ['2026-10-24T22:30:00.000Z', 'Europe/Madrid', '2026-10-25T23:00:00.000Z'],
    // DST starts 28 Mar 2027 at 02:00 CET: the midnight after it is CEST (+2).
    ['2027-03-27T12:00:00.000Z', 'Europe/Madrid', '2027-03-27T23:00:00.000Z'],
    ['2027-03-27T23:30:00.000Z', 'Europe/Madrid', '2027-03-28T22:00:00.000Z'],
    ['2026-11-01T05:00:00.000Z', 'America/New_York', '2026-11-02T05:00:00.000Z'],
    // Santiago's DST starts at midnight, skipping it (23:59 -04 to 01:00 -03 on
    // 6 Sept 2026): the day starts at the jump, never in the hour before it.
    ['2026-09-05T12:00:00.000Z', 'America/Santiago', '2026-09-06T04:00:00.000Z'],
    ['2026-09-06T03:30:00.000Z', 'America/Santiago', '2026-09-06T04:00:00.000Z'],
    // Its DST ends at midnight too (00:00 -03 back to 23:00 -04 on 4 Apr
    // 2026), from either pass through the repeated hour.
    ['2026-04-05T02:30:00.000Z', 'America/Santiago', '2026-04-05T04:00:00.000Z'],
    ['2026-04-05T03:30:00.000Z', 'America/Santiago', '2026-04-05T04:00:00.000Z'],
    // Havana repeats midnight (01:00 -04 back to 00:00 -05 on 1 Nov 2026): one
    // reset is enough.
    ['2026-11-01T04:00:00.000Z', 'America/Havana', '2026-11-02T05:00:00.000Z'],
    // Already tomorrow in Tokyo, and a quarter-hour offset in Kathmandu.
    ['2026-09-30T20:00:00.000Z', 'Asia/Tokyo', '2026-10-01T15:00:00.000Z'],
    ['2026-09-30T20:00:00.123Z', 'Asia/Kathmandu', '2026-10-01T18:15:00.000Z'],
    ['2026-12-31T23:30:00.000Z', 'UTC', '2027-01-01T00:00:00.000Z'],
  ])('from %s in %s: %s', (now, tz, expected) => {
    expect(nextResetAt(new Date(now), tz).toISOString()).toBe(expected);
  });
});

describe('scheduleDemoReset', () => {
  // Timers run on their own clock: one can fire while the wall clock still
  // reads the last day of the month (here frozen 50 ms before 1 Oct, Madrid).
  test('a reset that fires early still seeds the new month', async () => {
    await seedDemo(new Date('2026-09-29T10:00:00.000Z'));
    const lastMonth = async () => {
      const dates = (await db.select().from(transactions)).map((t) => t.transactionDate).sort();
      return currentMonth(new Date(dates.at(-1) ?? ''), 'Europe/Madrid');
    };
    const midnight = Date.parse('2026-09-30T22:00:00.000Z');
    setSystemTime(new Date(midnight - 50));
    try {
      scheduleDemoReset();
      for (let i = 0; i < 100 && (await lastMonth()) !== '2026-10'; i++) await Bun.sleep(20);
    } finally {
      setSystemTime();
    }
    expect(await lastMonth()).toBe('2026-10');
  });

  // A fresh process: an unref'd timer lets it exit, a ref'd one would hang it.
  test("doesn't keep the process alive", () => {
    const dir = mkdtempSync(join(tmpdir(), 'revbudget-demo-reset-'));
    try {
      const script = `
        const { scheduleDemoReset } = await import(${JSON.stringify(join(import.meta.dir, 'demo.ts'))});
        scheduleDemoReset();
      `;
      const proc = Bun.spawnSync([process.execPath, '-e', script], {
        env: { ...process.env, DATABASE_URL: join(dir, 'demo.db') },
        timeout: 15_000,
      });
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toContain('demo_reset_scheduled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
