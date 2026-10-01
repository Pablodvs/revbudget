import { and, eq, gte, lt, sql, sum } from 'drizzle-orm';
import { formatCents, formatMonth, monthBounds } from 'shared';
import { config } from '../config';
import { db } from '../db';
import { transactions, wallets } from '../db/schema';

// Spending is expenses + adjustments - refunds. Income is reported apart.
export const signedSpent = (type: string, amount: number): number => {
  if (type === 'expense' || type === 'adjustment') return amount;
  if (type === 'refund') return -amount;
  return 0;
};

type WalletAgg = { spent: number; income: number; count: number };
const emptyAgg = (): WalletAgg => ({ spent: 0, income: 0, count: 0 });

export type MonthlySummary = Awaited<ReturnType<typeof monthlySummary>>;

// The single monthly aggregation behind GET /api/stats/monthly and the
// Telegram /status command, so the dashboard and the bot can't disagree.
export async function monthlySummary(month: string, tz: string = config.APP_TIMEZONE) {
  const bounds = monthBounds(month, tz);
  if (!bounds) throw new Error(`invalid month: ${month}`);

  const walletRows = await db.select().from(wallets).orderBy(wallets.id);
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

  // An archived wallet still shows in any month it has activity in; dropping
  // it would silently rewrite that month's totals.
  const listed = walletRows.filter((w) => w.isActive || byWallet.has(w.id));
  const perWallet = listed.map((w) => {
    const agg = byWallet.get(w.id) ?? emptyAgg();
    return {
      walletId: w.id,
      walletName: w.name,
      color: w.color,
      icon: w.icon,
      currency: w.currency,
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

  return { month, totalSpent, totalBudget, totalIncome, transactionCount, perWallet };
}

// Plain-text /status reply. Plain text like every other bot message: wallet
// names are user-controlled, and an unbalanced Markdown char in one made
// Telegram reject the whole reply. The total is split per wallet currency.
export function formatMonthlySummary(summary: MonthlySummary): string {
  const totals = new Map<string, number>();
  const lines = summary.perWallet.map((w) => {
    totals.set(w.currency, (totals.get(w.currency) ?? 0) + w.spent);
    const pct = w.budget > 0 ? Math.round((w.spent / w.budget) * 100) : 0;
    return `${w.icon ?? ''} ${w.walletName}: ${formatCents(w.spent, w.currency)} / ${formatCents(w.budget, w.currency)} (${pct}%)`;
  });
  const total = [...totals].map(([currency, spent]) => formatCents(spent, currency)).join(' + ');
  return `📊 ${formatMonth(summary.month)}\nTotal: ${total || '-'}\n\n${lines.join('\n')}`;
}
