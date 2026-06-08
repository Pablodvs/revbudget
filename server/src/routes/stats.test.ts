import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { monthBounds, toZonedYearMonth } from 'shared';
import { db } from '../db';
import { parseFailures, transactions } from '../db/schema';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { authedHeaders, ensureMigrated, seedWallet, truncateAll } from '../test/db';

type MonthlyStats = {
  month: string;
  totalSpent: number;
  totalBudget: number;
  totalIncome: number;
  transactionCount: number;
  perWallet: Array<{
    walletId: number;
    spent: number;
    income: number;
    transactionCount: number;
  }>;
};

type Trends = {
  months: string[];
  series: Array<{ walletId: number; values: number[] }>;
  topMerchants: Array<{ merchantDisplay: string; total: number; count: number }>;
};

const { app } = await import('../app');
let AUTH: Record<string, string>;

beforeAll(async () => {
  ensureMigrated();
  AUTH = await authedHeaders();
});

afterAll(() => {
  stopRateLimitSweeper();
});

beforeEach(async () => {
  await truncateAll();
});

async function addTx(
  walletId: number,
  amount: number,
  transactionDate: string,
  merchant = 'tst',
  type: 'expense' | 'income' | 'refund' | 'adjustment' = 'expense',
) {
  await db.insert(transactions).values({
    walletId,
    amount,
    currency: 'EUR',
    merchant,
    merchantDisplay: merchant.toUpperCase(),
    rawText: `seed ${merchant}`,
    status: 'classified',
    type,
    classifiedAt: transactionDate,
    transactionDate,
  });
}

describe('GET /api/stats/monthly', () => {
  test('aggregates classified transactions for a month', async () => {
    const w1 = await seedWallet({ name: 'Food', budget: 10000 });
    const w2 = await seedWallet({ name: 'Transport', budget: 5000 });

    await addTx(w1.id, 1000, '2026-03-15T12:00:00Z');
    await addTx(w1.id, 2500, '2026-03-20T12:00:00Z');
    await addTx(w2.id, 700, '2026-03-10T09:00:00Z');
    await addTx(w1.id, 999, '2026-02-28T12:00:00Z'); // out of month

    const res = await app.request('/api/stats/monthly?month=2026-03', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonthlyStats;

    expect(body.month).toBe('2026-03');
    expect(body.totalBudget).toBe(15000);
    expect(body.transactionCount).toBe(3);
    expect(body.totalSpent).toBe(4200);

    const foodEntry = body.perWallet.find((p) => p.walletId === w1.id);
    expect(foodEntry?.spent).toBe(3500);
    expect(foodEntry?.transactionCount).toBe(2);
  });

  test('excludes parse_failures rows entirely', async () => {
    const w = await seedWallet({ name: 'Food' });
    await addTx(w.id, 1000, '2026-03-15T12:00:00Z');
    await db.insert(parseFailures).values({
      rawText: 'junk',
      errorCode: 'no_match',
      receivedAt: '2026-03-10T12:00:00Z',
    });

    const res = await app.request('/api/stats/monthly?month=2026-03', { headers: AUTH });
    const body = (await res.json()) as MonthlyStats;
    expect(body.totalSpent).toBe(1000);
    expect(body.transactionCount).toBe(1);
  });

  test('applies type formula: expense + adjustment - refund, income separate', async () => {
    const w = await seedWallet({ name: 'Food', budget: 10000 });

    await addTx(w.id, 10000, '2026-03-05T12:00:00Z', 'shop', 'expense');
    await addTx(w.id, 1000, '2026-03-06T12:00:00Z', 'shop', 'adjustment');
    await addTx(w.id, 3000, '2026-03-07T12:00:00Z', 'shop', 'refund');
    await addTx(w.id, 5000, '2026-03-08T12:00:00Z', 'boss', 'income');

    const res = await app.request('/api/stats/monthly?month=2026-03', { headers: AUTH });
    const body = (await res.json()) as MonthlyStats;

    // 10000 + 1000 - 3000 = 8000
    expect(body.totalSpent).toBe(8000);
    expect(body.totalIncome).toBe(5000);
    expect(body.transactionCount).toBe(4);

    const entry = body.perWallet.find((p) => p.walletId === w.id);
    expect(entry?.spent).toBe(8000);
    expect(entry?.income).toBe(5000);
    expect(entry?.transactionCount).toBe(4);
  });

  test('income only: spent stays 0, income reported', async () => {
    const w = await seedWallet({ name: 'Salary', budget: 0 });
    await addTx(w.id, 200000, '2026-03-25T10:00:00Z', 'payroll', 'income');

    const res = await app.request('/api/stats/monthly?month=2026-03', { headers: AUTH });
    const body = (await res.json()) as MonthlyStats;
    expect(body.totalSpent).toBe(0);
    expect(body.totalIncome).toBe(200000);
    const entry = body.perWallet.find((p) => p.walletId === w.id);
    expect(entry?.spent).toBe(0);
    expect(entry?.income).toBe(200000);
  });

  test('refunds greater than expenses produce negative spent', async () => {
    const w = await seedWallet({ name: 'Food' });
    await addTx(w.id, 500, '2026-03-05T12:00:00Z', 'a', 'expense');
    await addTx(w.id, 2000, '2026-03-06T12:00:00Z', 'a', 'refund');

    const res = await app.request('/api/stats/monthly?month=2026-03', { headers: AUTH });
    const body = (await res.json()) as MonthlyStats;
    expect(body.totalSpent).toBe(-1500);
    const entry = body.perWallet.find((p) => p.walletId === w.id);
    expect(entry?.spent).toBe(-1500);
  });

  test('TZ boundary: midnight Madrid on 1st falls in correct local month', async () => {
    const w = await seedWallet({ name: 'Food' });
    // 2026-05-01T00:30 in Europe/Madrid is 2026-04-30T22:30Z.
    // UTC-bucketing would put this in April; Madrid should put it in May.
    await addTx(w.id, 1234, '2026-04-30T22:30:00Z', 'mad1');

    const resMay = await app.request('/api/stats/monthly?month=2026-05', { headers: AUTH });
    const mayBody = (await resMay.json()) as MonthlyStats;
    expect(mayBody.totalSpent).toBe(1234);

    const resApr = await app.request('/api/stats/monthly?month=2026-04', { headers: AUTH });
    const aprBody = (await resApr.json()) as MonthlyStats;
    expect(aprBody.totalSpent).toBe(0);
  });
});

describe('GET /api/stats/trends', () => {
  test('series apply formula and exclude income; topMerchants only expense+adjustment', async () => {
    const w = await seedWallet({ name: 'Food', budget: 10000 });

    // Use current month to land inside the trailing 6-month window.
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = (d: number) => `${y}-${m}-${String(d).padStart(2, '0')}T12:00:00Z`;

    await addTx(w.id, 10000, day(5), 'shop', 'expense');
    await addTx(w.id, 1000, day(6), 'shop', 'adjustment');
    await addTx(w.id, 3000, day(7), 'shop', 'refund');
    await addTx(w.id, 5000, day(8), 'boss', 'income');
    await addTx(w.id, 2000, day(9), 'market', 'expense');

    const res = await app.request('/api/stats/trends', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Trends;

    const series = body.series.find((s) => s.walletId === w.id);
    expect(series).toBeDefined();
    // 10000 + 1000 - 3000 + 2000 = 10000 (income excluded)
    const last = series?.values.at(-1);
    expect(last).toBe(10000);

    // topMerchants: shop (10000 expense + 1000 adjustment = 11000) and market (2000).
    // "boss" (income) and the refund row must not appear as their own entries.
    const names = body.topMerchants.map((m) => m.merchantDisplay);
    expect(names).toContain('SHOP');
    expect(names).toContain('MARKET');
    expect(names).not.toContain('BOSS');

    const shop = body.topMerchants.find((m) => m.merchantDisplay === 'SHOP');
    // sum uses raw amount (expense+adjustment), no refund subtraction on this listing
    expect(shop?.total).toBe(11000);
    expect(shop?.count).toBe(2);
  });
});

describe('monthBounds/toZonedYearMonth (shared helpers)', () => {
  test('monthBounds in Europe/Madrid returns correct UTC anchors', () => {
    // Europe/Madrid is UTC+2 in July (DST)
    const b = monthBounds('2026-07', 'Europe/Madrid');
    expect(b?.startISO).toBe('2026-06-30T22:00:00.000Z');
    expect(b?.endISO).toBe('2026-07-31T22:00:00.000Z');
  });

  test('monthBounds in January (no DST) returns UTC+1 anchors', () => {
    const b = monthBounds('2026-01', 'Europe/Madrid');
    expect(b?.startISO).toBe('2025-12-31T23:00:00.000Z');
    expect(b?.endISO).toBe('2026-01-31T23:00:00.000Z');
  });

  test('toZonedYearMonth maps UTC to local wall clock', () => {
    // 23:30 UTC on Dec 31 in Madrid is 00:30 local on Jan 1.
    expect(toZonedYearMonth('2025-12-31T23:30:00.000Z', 'Europe/Madrid')).toBe('2026-01');
  });
});
