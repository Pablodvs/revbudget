// Demo data for a first look at the dashboard: `bun run db:seed:demo`.
// Everything is synthetic, and dates are relative to now, so the current month
// always has data: budgets at 40-110% (green, amber and red bars), pending and
// to-confirm items, income, a refund, an adjustment and a few merchant rules.
import { count } from 'drizzle-orm';
import { currentMonth, monthBounds, normalizePattern, shiftMonth } from 'shared';
import { config } from '../config';
import { auth } from '../lib/auth';
import { db } from './index';
import { type TransactionInsert, merchantRules, transactions, user, wallets } from './schema';
import { type SeedWalletName, seedWalletRows } from './seed';

export const DEMO_EMAIL = 'demo@example.com';
export const DEMO_PASSWORD = 'revbudget-demo';

// Loopback, and private-LAN IP literals (10/8, 172.16/12, 192.168/16): a
// developer's own machine or network. Any other host may be public.
const LOCAL_HOST =
  /^(localhost|\[::1\]|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/;

// [wallet, merchant, cents, day of month]
type Spend = [SeedWalletName, string, number, number];
type Unassigned = [null, string, number, number];

// Recurring spending, repeated every month (scaled by MONTH_FACTORS).
const MONTHLY: Spend[] = [
  ['Food', 'Tesco', 5840, 2],
  ['Food', 'Starbucks', 460, 3],
  ['Food', 'Lidl', 3215, 5],
  ['Food', 'Tesco Express', 1290, 7],
  ['Food', 'Pret A Manger', 875, 8],
  ['Food', 'Tesco', 6120, 10],
  ['Food', 'Starbucks', 520, 12],
  ['Food', 'Lidl', 2890, 14],
  ['Food', 'Tesco', 5040, 18],
  ['Transport', 'Uber', 1850, 4],
  ['Transport', 'Shell', 4200, 9],
  ['Transport', 'Uber', 700, 15],
  ['Entertainment', 'Odeon Cinema', 2400, 6],
  ['Entertainment', 'Steam', 5999, 11],
  ['Subscriptions', 'Netflix', 1299, 1],
  ['Subscriptions', 'Spotify', 1099, 2],
  ['Subscriptions', 'Apple iCloud', 299, 3],
  ['Subscriptions', 'YouTube Premium', 1199, 3],
  ['Home', 'Vodafone', 3500, 10],
  ['Home', 'B&Q', 1700, 12],
  ['Health', 'PureGym', 2550, 1],
  ['Health', 'Boots', 1450, 5],
  ['Other', 'Amazon', 4599, 4],
  ['Other', 'Post Office', 850, 11],
  ['Other', 'H&M', 2851, 19],
];

// This month's one-offs. With MONTHLY they put Transport, Home and Health in
// the green, Food and Subscriptions in the amber, Entertainment and Other in the red.
const THIS_MONTH: Spend[] = [
  ['Food', 'Deliveroo', 2450, 16],
  ['Entertainment', 'Ticketmaster', 9500, 13],
  ['Entertainment', 'PlayStation Store', 3701, 17],
  ['Other', 'Amazon', 6200, 16],
];

// Oldest to this month: six months, so the Stats 6-month trend is full.
const MONTH_FACTORS = [0.94, 1.05, 0.9, 0.86, 1.12, 1] as const;

// Waiting in the dashboard's queue this month: merchants no rule knows yet...
const PENDING: Unassigned[] = [
  [null, 'City Parking', 300, 18],
  [null, 'Corner Shop', 675, 19],
  [null, 'Local Bakery', 420, 20],
  [null, 'Farmers Market', 1500, 20],
];
// ...and Amazon suggestions held back by its requireConfirmation rule.
const TO_CONFIRM: Spend[] = [
  ['Other', 'Amazon Marketplace', 1899, 19],
  ['Other', 'Amazon Prime', 899, 20],
];

const RULES = [
  { pattern: 'tesco', wallet: 'Food', matchType: 'contains', requireConfirmation: false },
  { pattern: 'uber', wallet: 'Transport', matchType: 'contains', requireConfirmation: false },
  { pattern: 'netflix', wallet: 'Subscriptions', matchType: 'exact', requireConfirmation: false },
  { pattern: 'spotify', wallet: 'Subscriptions', matchType: 'exact', requireConfirmation: false },
  // Amazon sells everything, so its suggestion waits for a confirmation.
  { pattern: 'amazon', wallet: 'Other', matchType: 'contains', requireConfirmation: true },
] as const;

export async function seedDemo(now = new Date()): Promise<string[]> {
  if (config.NODE_ENV === 'production') {
    throw new Error('refusing to run with NODE_ENV=production: demo data is fake');
  }
  // NODE_ENV is unset on a host checkout, so a production .env can still get
  // here; its public origin gives it away. The demo admin's password is public.
  const publicOrigin = [config.BETTER_AUTH_URL, ...config.trustedOrigins].find(
    (url) => url && !LOCAL_HOST.test(new URL(url).hostname),
  );
  if (publicOrigin) {
    throw new Error(
      `refusing to run: configured for ${publicOrigin}, and the demo admin's password is public`,
    );
  }
  const [txCount] = await db.select({ n: count() }).from(transactions);
  if (txCount && txCount.n > 0) {
    throw new Error(
      `refusing to run: the database already has ${txCount.n} transactions; demo data only goes into an empty database (point DATABASE_URL at a new file)`,
    );
  }
  const report: string[] = [];

  const existing = new Set(
    (await db.select({ name: wallets.name }).from(wallets)).map((w) => w.name),
  );
  const missing = seedWalletRows().filter((w) => !existing.has(w.name));
  if (missing.length > 0) await db.insert(wallets).values(missing);
  const walletId = new Map((await db.select().from(wallets)).map((w) => [w.name, w.id]));
  const idOf = (name: SeedWalletName): number => {
    const id = walletId.get(name);
    if (id === undefined) throw new Error(`wallet missing: ${name}`);
    return id;
  };
  report.push(`wallets: ${missing.length} default wallets created, ${walletId.size} total`);

  const [userCount] = await db.select({ n: count() }).from(user);
  if (!userCount || userCount.n === 0) {
    // Same path as create-admin: better-auth hashes and stores the password.
    await auth.api.createUser({
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Demo', role: 'admin' },
    });
    report.push(`demo admin created: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  } else {
    report.push('users already exist: sign in with your own account (no demo admin created)');
  }

  const thisMonth = currentMonth(now, config.APP_TIMEZONE);
  const months = MONTH_FACTORS.map((_, i) => shiftMonth(thisMonth, i - (MONTH_FACTORS.length - 1)));
  // Spreads a month's planned days over the part of it that has happened, so
  // the current month never contains a future transaction.
  const dateIn = (month: string, day: number): string => {
    const bounds = monthBounds(month, config.APP_TIMEZONE);
    if (!bounds) throw new Error(`bad month: ${month}`);
    const start = Date.parse(bounds.startISO);
    const end = Math.min(Date.parse(bounds.endISO), now.getTime());
    return new Date(start + ((day - 0.5) / 31) * (end - start)).toISOString();
  };
  const tx = (
    month: string,
    [wallet, merchant, amount, day]: Spend | Unassigned,
    extra: Partial<TransactionInsert> = {},
  ): TransactionInsert => {
    const transactionDate = dateIn(month, day);
    const status = extra.status ?? 'classified';
    return {
      walletId: wallet ? idOf(wallet) : null,
      amount,
      currency: 'EUR',
      merchant: normalizePattern(merchant),
      merchantDisplay: merchant,
      rawText: 'demo',
      status,
      classifiedAt: status === 'classified' ? transactionDate : null,
      transactionDate,
      ...extra,
    };
  };

  // One synchronous transaction (drizzle's bun-sqlite transactions can't
  // await): the demo lands whole or not at all.
  const inserted = db.transaction((t) => {
    let n = 0;
    const insert = (row: TransactionInsert) => {
      n++;
      return t.insert(transactions).values(row).returning().get();
    };
    months.forEach((month, i) => {
      const factor = MONTH_FACTORS[i] ?? 1;
      insert(tx(month, ['Other', 'Acme Corp Payroll', 285000, 1], { type: 'income' }));
      for (const [wallet, merchant, cents, day] of MONTHLY) {
        insert(tx(month, [wallet, merchant, Math.round(cents * factor), day]));
      }
    });

    for (const spend of THIS_MONTH) insert(tx(thisMonth, spend));
    const sofa = insert(tx(thisMonth, ['Home', 'IKEA', 8950, 6]));
    insert(
      tx(thisMonth, ['Home', 'IKEA', 350, 8], {
        type: 'adjustment',
        relatedTxId: sofa.id,
        description: 'Delivery surcharge',
      }),
    );
    const order = insert(tx(thisMonth, ['Other', 'Amazon', 2999, 9]));
    insert(
      tx(thisMonth, ['Other', 'Amazon', 2999, 14], {
        type: 'refund',
        relatedTxId: order.id,
        description: 'Returned item',
      }),
    );
    for (const spend of PENDING) insert(tx(thisMonth, spend, { status: 'pending' }));
    for (const spend of TO_CONFIRM) {
      insert(tx(thisMonth, spend, { status: 'pending_confirmation' }));
    }

    for (const r of RULES) {
      t.insert(merchantRules)
        .values({
          pattern: r.pattern,
          walletId: idOf(r.wallet),
          matchType: r.matchType,
          requireConfirmation: r.requireConfirmation,
        })
        .run();
    }
    return n;
  });
  report.push(
    `inserted ${inserted} transactions (${months[0]} to ${thisMonth}) and ${RULES.length} merchant rules`,
  );
  return report;
}

if (import.meta.main) {
  seedDemo()
    .then((report) => {
      for (const line of report) console.log(`[seed-demo] ${line}`);
    })
    .catch((err) => {
      console.error(`[seed-demo] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
