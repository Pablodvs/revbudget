import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { monthBounds, toZonedYearMonth } from 'shared';
import { db } from '../db';
import { parseFailures, transactions } from '../db/schema';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { ensureMigrated, seedWallet, truncateAll } from '../test/db';

type MonthlyStats = {
  month: string;
  totalSpent: number;
  totalBudget: number;
  transactionCount: number;
  perWallet: Array<{
    walletId: number;
    spent: number;
    transactionCount: number;
  }>;
};

const { app } = await import('../app');
const AUTH = { Authorization: `Bearer ${process.env.API_TOKEN}` };

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
});

beforeEach(async () => {
  await truncateAll();
});

async function addTx(walletId: number, amount: number, transactionDate: string, merchant = 'tst') {
  await db.insert(transactions).values({
    walletId,
    amount,
    currency: 'EUR',
    merchant,
    merchantDisplay: merchant.toUpperCase(),
    rawText: `seed ${merchant}`,
    status: 'classified',
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
