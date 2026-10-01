import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { formatCents } from 'shared';
import { db } from '../db';
import { transactions } from '../db/schema';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { authedHeaders, ensureMigrated, seedWallet, truncateAll } from '../test/db';
import { formatMonthlySummary, monthlySummary } from './stats';

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

type TxType = 'expense' | 'income' | 'refund' | 'adjustment';
type TxStatus = 'classified' | 'pending';

async function addTx(walletId: number | null, amount: number, type: TxType, status: TxStatus) {
  await db.insert(transactions).values({
    walletId,
    amount,
    merchant: 'shop',
    merchantDisplay: 'Shop',
    rawText: 'seed',
    status,
    type,
    transactionDate: '2026-03-10T12:00:00.000Z',
  });
}

describe('monthlySummary (dashboard stats + Telegram /status)', () => {
  test('/status reports the same totals as GET /api/stats/monthly for a mix of types', async () => {
    const food = await seedWallet({ name: 'Food', budget: 10000 });
    const home = await seedWallet({ name: 'Home', budget: 5000 });
    await addTx(food.id, 10000, 'expense', 'classified');
    await addTx(food.id, 1000, 'adjustment', 'classified');
    await addTx(food.id, 3000, 'refund', 'classified');
    await addTx(food.id, 5000, 'income', 'classified');
    await addTx(home.id, 2500, 'expense', 'classified');
    await addTx(null, 9999, 'expense', 'pending');

    const res = await app.request('/api/stats/monthly?month=2026-03', { headers: AUTH });
    const route = await res.json();
    const summary = await monthlySummary('2026-03');
    expect(summary).toEqual(route);

    // Before the shared aggregation, /status summed every type: 21500 here.
    expect(route.totalSpent).toBe(10500);
    const text = formatMonthlySummary(summary);
    expect(text).toContain(`Total: ${formatCents(10500, 'EUR')}`);
    expect(text).toContain(
      `Food: ${formatCents(8000, 'EUR')} / ${formatCents(10000, 'EUR')} (80%)`,
    );
    expect(text).toContain(`Home: ${formatCents(2500, 'EUR')} / ${formatCents(5000, 'EUR')} (50%)`);
  });

  test('/status totals each wallet currency separately instead of assuming EUR', async () => {
    const eur = await seedWallet({ name: 'Food', currency: 'EUR' });
    const usd = await seedWallet({ name: 'Trip', currency: 'USD' });
    await addTx(eur.id, 1200, 'expense', 'classified');
    await addTx(usd.id, 3400, 'expense', 'classified');

    const text = formatMonthlySummary(await monthlySummary('2026-03'));
    expect(text).toContain(`Total: ${formatCents(1200, 'EUR')} + ${formatCents(3400, 'USD')}`);
  });

  // Dropping an archived wallet would silently rewrite that month's totals.
  test('keeps an archived wallet in a month it has activity in', async () => {
    const food = await seedWallet({ name: 'Food', budget: 10000 });
    const old = await seedWallet({ name: 'Old', budget: 5000, isActive: false });
    await seedWallet({ name: 'Unused', isActive: false });
    await addTx(food.id, 1000, 'expense', 'classified');
    await addTx(old.id, 2500, 'expense', 'classified');

    const summary = await monthlySummary('2026-03');
    expect(summary.perWallet.map((w) => w.walletName)).toEqual(['Food', 'Old']);
    expect(summary.totalSpent).toBe(3500);
    expect(summary.totalBudget).toBe(15000);
  });
});
