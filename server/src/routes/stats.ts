import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, inArray, lt, ne, sql, sum } from 'drizzle-orm';
import { Hono } from 'hono';
import { MonthQuerySchema, currentMonth, monthBounds, shiftMonth, toZonedYearMonth } from 'shared';
import { config } from '../config';
import { db } from '../db';
import { transactions, wallets } from '../db/schema';

type WalletAgg = { spent: number; income: number; count: number };
const emptyAgg = (): WalletAgg => ({ spent: 0, income: 0, count: 0 });
const signedSpent = (type: string, amount: number): number => {
  if (type === 'expense' || type === 'adjustment') return amount;
  if (type === 'refund') return -amount;
  return 0;
};

const tz = () => config.APP_TIMEZONE;

export const statsRoute = new Hono()
  .get('/monthly', zValidator('query', MonthQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const month = q.month ?? currentMonth(new Date(), tz());
    const bounds = monthBounds(month, tz());
    if (!bounds) return c.json({ error: 'bad_month', requestId: '' }, 400);

    const walletRows = await db.select().from(wallets).where(eq(wallets.isActive, true));
    const totals = await db
      .select({
        walletId: transactions.walletId,
        type: transactions.type,
        total: sum(transactions.amount).mapWith(Number),
        count: sql<number>`COUNT(*)`.mapWith(Number),
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'classified'),
          gte(transactions.transactionDate, bounds.startISO),
          lt(transactions.transactionDate, bounds.endISO),
        ),
      )
      .groupBy(transactions.walletId, transactions.type);

    const byWallet = new Map<number, WalletAgg>();
    for (const r of totals) {
      if (r.walletId == null) continue;
      const agg = byWallet.get(r.walletId) ?? emptyAgg();
      const total = r.total ?? 0;
      if (r.type === 'income') agg.income += total;
      else agg.spent += signedSpent(r.type, total);
      agg.count += r.count ?? 0;
      byWallet.set(r.walletId, agg);
    }

    const perWallet = walletRows.map((w) => {
      const agg = byWallet.get(w.id) ?? emptyAgg();
      return {
        walletId: w.id,
        walletName: w.name,
        color: w.color,
        icon: w.icon,
        budget: w.budget,
        spent: agg.spent,
        income: agg.income,
        transactionCount: agg.count,
      };
    });
    const totalSpent = perWallet.reduce((acc, w) => acc + w.spent, 0);
    const totalIncome = perWallet.reduce((acc, w) => acc + w.income, 0);
    const totalBudget = perWallet.reduce((acc, w) => acc + w.budget, 0);
    const transactionCount = perWallet.reduce((acc, w) => acc + w.transactionCount, 0);

    return c.json({ month, totalSpent, totalBudget, totalIncome, transactionCount, perWallet });
  })
  .get('/trends', async (c) => {
    const now = currentMonth(new Date(), tz());
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) months.push(shiftMonth(now, -i));
    const firstMonth = months[0];
    const lastMonth = months[months.length - 1];
    if (!firstMonth || !lastMonth) {
      return c.json({ months: [], series: [], topMerchants: [] });
    }
    const startBounds = monthBounds(firstMonth, tz());
    const endBounds = monthBounds(lastMonth, tz());
    if (!startBounds || !endBounds) {
      return c.json({ months: [], series: [], topMerchants: [] });
    }

    const walletRows = await db.select().from(wallets).where(eq(wallets.isActive, true));
    const rawRows = await db
      .select({
        walletId: transactions.walletId,
        transactionDate: transactions.transactionDate,
        amount: transactions.amount,
        type: transactions.type,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'classified'),
          ne(transactions.type, 'income'),
          gte(transactions.transactionDate, startBounds.startISO),
          lt(transactions.transactionDate, endBounds.endISO),
        ),
      );

    const totalsByWalletMonth = new Map<string, number>();
    for (const r of rawRows) {
      if (r.walletId === null) continue;
      const localMonth = toZonedYearMonth(r.transactionDate, tz());
      const key = `${r.walletId}:${localMonth}`;
      const delta = signedSpent(r.type, r.amount);
      totalsByWalletMonth.set(key, (totalsByWalletMonth.get(key) ?? 0) + delta);
    }

    const series = walletRows.map((w) => ({
      walletId: w.id,
      walletName: w.name,
      color: w.color,
      values: months.map((m) => Math.max(0, totalsByWalletMonth.get(`${w.id}:${m}`) ?? 0)),
    }));

    const topMerchantRows = await db
      .select({
        merchantDisplay: transactions.merchantDisplay,
        total: sum(transactions.amount).mapWith(Number),
        count: sql<number>`COUNT(*)`.mapWith(Number),
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'classified'),
          inArray(transactions.type, ['expense', 'adjustment']),
          gte(transactions.transactionDate, startBounds.startISO),
          lt(transactions.transactionDate, endBounds.endISO),
        ),
      )
      .groupBy(transactions.merchantDisplay)
      .orderBy(desc(sum(transactions.amount)))
      .limit(5);

    return c.json({
      months,
      series,
      topMerchants: topMerchantRows.map((r) => ({
        merchantDisplay: r.merchantDisplay,
        total: r.total ?? 0,
        count: r.count ?? 0,
      })),
    });
  });
