import { and, desc, eq, gte, inArray, lt, ne, sql, sum } from 'drizzle-orm';
import { Hono } from 'hono';
import { MonthQuerySchema, currentMonth, monthBounds, shiftMonth, toZonedYearMonth } from 'shared';
import { config } from '../config';
import { db } from '../db';
import { transactions, wallets } from '../db/schema';
import { validate } from '../lib/validate';
import { monthlySummary, signedSpent } from '../services/stats';

const tz = () => config.APP_TIMEZONE;

export const statsRoute = new Hono()
  .get('/monthly', validate('query', MonthQuerySchema), async (c) => {
    const { month } = c.req.valid('query');
    return c.json(await monthlySummary(month ?? currentMonth(new Date(), tz())));
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

    const walletRows = await db.select().from(wallets).orderBy(wallets.id);
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
    const walletsWithSpend = new Set<number>();
    for (const r of rawRows) {
      if (r.walletId === null) continue;
      walletsWithSpend.add(r.walletId);
      const localMonth = toZonedYearMonth(r.transactionDate, tz());
      const key = `${r.walletId}:${localMonth}`;
      const delta = signedSpent(r.type, r.amount);
      totalsByWalletMonth.set(key, (totalsByWalletMonth.get(key) ?? 0) + delta);
    }

    // Archived wallets stay in the months they have spend in (see monthlySummary).
    const series = walletRows
      .filter((w) => w.isActive || walletsWithSpend.has(w.id))
      .map((w) => ({
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
