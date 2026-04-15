import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, lt, sql, sum } from 'drizzle-orm';
import { Hono } from 'hono';
import { MonthQuerySchema, currentMonth, monthBounds, shiftMonth, toZonedYearMonth } from 'shared';
import { config } from '../config';
import { db } from '../db';
import { transactions, wallets } from '../db/schema';

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
      .groupBy(transactions.walletId);

    const byWallet = new Map(totals.map((t) => [t.walletId, t]));
    const perWallet = walletRows.map((w) => {
      const agg = byWallet.get(w.id);
      return {
        walletId: w.id,
        walletName: w.name,
        color: w.color,
        icon: w.icon,
        budget: w.budget,
        spent: agg?.total ?? 0,
        transactionCount: agg?.count ?? 0,
      };
    });
    const totalSpent = perWallet.reduce((acc, w) => acc + w.spent, 0);
    const totalBudget = perWallet.reduce((acc, w) => acc + w.budget, 0);
    const transactionCount = perWallet.reduce((acc, w) => acc + w.transactionCount, 0);

    return c.json({ month, totalSpent, totalBudget, transactionCount, perWallet });
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
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'classified'),
          gte(transactions.transactionDate, startBounds.startISO),
          lt(transactions.transactionDate, endBounds.endISO),
        ),
      );

    const totalsByWalletMonth = new Map<string, number>();
    for (const r of rawRows) {
      if (r.walletId === null) continue;
      const localMonth = toZonedYearMonth(r.transactionDate, tz());
      const key = `${r.walletId}:${localMonth}`;
      totalsByWalletMonth.set(key, (totalsByWalletMonth.get(key) ?? 0) + r.amount);
    }

    const series = walletRows.map((w) => ({
      walletId: w.id,
      walletName: w.name,
      color: w.color,
      values: months.map((m) => totalsByWalletMonth.get(`${w.id}:${m}`) ?? 0),
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
