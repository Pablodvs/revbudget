import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { merchantRules, transactions } from '../db/schema';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { ensureMigrated, seedWallet, truncateAll } from '../test/db';
import {
  classifyMerchant,
  classifyTransaction,
  deleteExactRule,
  invalidateContainsCache,
  unclassifyTransaction,
  upsertExactRule,
} from './classifier';

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
});

beforeEach(async () => {
  await truncateAll();
  invalidateContainsCache();
});

describe('classifyMerchant', () => {
  test('returns null result when no rules exist', async () => {
    const result = await classifyMerchant('mercadona');
    expect(result.walletId).toBeNull();
    expect(result.wallet).toBeNull();
    expect(result.matchType).toBeNull();
  });

  test('exact match returns wallet', async () => {
    const wallet = await seedWallet({ name: 'Food' });
    await db
      .insert(merchantRules)
      .values({ pattern: 'mercadona', walletId: wallet.id, matchType: 'exact' });
    invalidateContainsCache();

    const result = await classifyMerchant('mercadona');
    expect(result.walletId).toBe(wallet.id);
    expect(result.matchType).toBe('exact');
    expect(result.wallet?.name).toBe('Food');
  });

  test('contains match returns wallet with word boundaries', async () => {
    const wallet = await seedWallet({ name: 'Transport' });
    await db
      .insert(merchantRules)
      .values({ pattern: 'uber', walletId: wallet.id, matchType: 'contains' });
    invalidateContainsCache();

    const matched = await classifyMerchant('uber eats barcelona');
    expect(matched.matchType).toBe('contains');
    expect(matched.walletId).toBe(wallet.id);

    const notMatched = await classifyMerchant('tuberculosis center');
    expect(notMatched.walletId).toBeNull();
  });

  test('exact takes precedence over contains', async () => {
    const foodWallet = await seedWallet({ name: 'Food' });
    const subsWallet = await seedWallet({ name: 'Subs' });
    await db.insert(merchantRules).values([
      { pattern: 'lidl barcelona', walletId: foodWallet.id, matchType: 'exact' },
      { pattern: 'lidl', walletId: subsWallet.id, matchType: 'contains' },
    ]);
    invalidateContainsCache();

    const result = await classifyMerchant('lidl barcelona');
    expect(result.matchType).toBe('exact');
    expect(result.walletId).toBe(foodWallet.id);
  });

  test('empty merchant returns null', async () => {
    const result = await classifyMerchant('');
    expect(result.walletId).toBeNull();
  });

  test('contains cache reflects invalidation', async () => {
    const wallet = await seedWallet({ name: 'Food' });
    await db
      .insert(merchantRules)
      .values({ pattern: 'lidl', walletId: wallet.id, matchType: 'contains' });
    invalidateContainsCache();
    const before = await classifyMerchant('lidl bcn');
    expect(before.walletId).toBe(wallet.id);

    await db.delete(merchantRules);
    invalidateContainsCache();
    const after = await classifyMerchant('lidl bcn');
    expect(after.walletId).toBeNull();
  });
});

describe('upsertExactRule / deleteExactRule', () => {
  test('upsert inserts then updates wallet on duplicate pattern', async () => {
    const a = await seedWallet({ name: 'A' });
    const b = await seedWallet({ name: 'B' });
    upsertExactRule('netflix', a.id);
    const first = await classifyMerchant('netflix');
    expect(first.walletId).toBe(a.id);
    expect(first.requireConfirmation).toBe(false);

    upsertExactRule('netflix', b.id);
    const second = await classifyMerchant('netflix');
    expect(second.walletId).toBe(b.id);
    expect(second.requireConfirmation).toBe(false);
  });

  test("upsert leaves a user's contains rule on the same pattern untouched", async () => {
    const shopping = await seedWallet({ name: 'Shopping' });
    const gifts = await seedWallet({ name: 'Gifts' });
    await db.insert(merchantRules).values(containsRule('amazon', shopping.id));

    upsertExactRule('amazon', gifts.id);
    expect(await rules()).toEqual([['amazon', 'contains', shopping.id]]);
  });

  test('deleteExactRule removes the learned rule created at that time, never a contains rule', async () => {
    const w = await seedWallet({ name: 'A' });
    const learnedAt = '2026-03-10T12:00:00.000Z';
    upsertExactRule('hbo', w.id, db, learnedAt);
    const [amazon] = await db
      .insert(merchantRules)
      .values(containsRule('amazon', w.id))
      .returning();

    deleteExactRule('hbo', '2026-03-10T12:00:00.001Z');
    expect((await classifyMerchant('hbo')).walletId).toBe(w.id);
    deleteExactRule('hbo', learnedAt);
    deleteExactRule('amazon', amazon?.createdAt ?? '');
    expect((await classifyMerchant('hbo')).walletId).toBeNull();
    expect(await rules()).toEqual([['amazon', 'contains', w.id]]);
  });
});

describe('classifyTransaction / unclassifyTransaction (Telegram buttons)', () => {
  afterEach(() => {
    db.$client.exec('DROP TRIGGER IF EXISTS fail_write');
  });

  test('classifying an expense learns an exact rule; undo forgets it', async () => {
    const w = await seedWallet();
    const tx = await pendingTx('expense');

    classifyTransaction(tx, w.id);
    expect(await txRow(tx.id)).toMatchObject({ walletId: w.id, status: 'classified' });
    expect(await rules()).toEqual([['corner shop', 'exact', w.id]]);

    unclassifyTransaction(await classifiedTx(tx.id));
    expect(await txRow(tx.id)).toMatchObject({
      walletId: null,
      status: 'pending',
      classifiedAt: null,
    });
    expect(await rules()).toEqual([]);
  });

  test('income and refunds are classified without teaching (or forgetting) a rule', async () => {
    const w = await seedWallet();
    const other = await seedWallet({ name: 'Other' });
    upsertExactRule('corner shop', other.id); // learned earlier from an expense
    for (const type of ['income', 'refund'] as const) {
      const tx = await pendingTx(type);
      classifyTransaction(tx, w.id);
      expect(await txRow(tx.id)).toMatchObject({ walletId: w.id, status: 'classified' });
      unclassifyTransaction(tx);
    }
    expect(await rules()).toEqual([['corner shop', 'exact', other.id]]);
  });

  test('undo keeps a contains rule covering the merchant', async () => {
    const w = await seedWallet();
    await db.insert(merchantRules).values(containsRule('corner shop', w.id));
    const tx = await pendingTx('expense');
    classifyTransaction(tx, w.id);
    unclassifyTransaction(await classifiedTx(tx.id));
    expect(await rules()).toEqual([['corner shop', 'contains', w.id]]);
  });

  // The rule predates the classification, so undoing it has nothing to forget.
  test("undo keeps an exact rule it didn't create, such as the user's own", async () => {
    const w = await seedWallet();
    await db
      .insert(merchantRules)
      .values({ pattern: 'corner shop', walletId: w.id, matchType: 'exact' });
    const tx = await pendingTx('expense');
    classifyTransaction(tx, w.id);
    unclassifyTransaction(await classifiedTx(tx.id));
    expect(await rules()).toEqual([['corner shop', 'exact', w.id]]);
    expect(await txRow(tx.id)).toMatchObject({ walletId: null, status: 'pending' });
  });

  test('classify is atomic: a failed rule write leaves the transaction pending', async () => {
    const w = await seedWallet();
    const tx = await pendingTx('expense');
    failWrites('INSERT', 'merchant_rules'); // the step after the transaction update
    expect(() => classifyTransaction(tx, w.id)).toThrow('write failed');
    expect(await txRow(tx.id)).toMatchObject({ walletId: null, status: 'pending' });
  });

  test('undo is atomic: a failed transaction update keeps the learned rule', async () => {
    const w = await seedWallet();
    const tx = await pendingTx('expense');
    classifyTransaction(tx, w.id);
    const classified = await classifiedTx(tx.id);
    failWrites('UPDATE', 'transactions'); // the step after the rule delete
    expect(() => unclassifyTransaction(classified)).toThrow('write failed');
    expect(await rules()).toEqual([['corner shop', 'exact', w.id]]);
    expect(await txRow(tx.id)).toMatchObject({ walletId: w.id, status: 'classified' });
  });
});

function containsRule(pattern: string, walletId: number) {
  return { pattern, walletId, matchType: 'contains' as const, requireConfirmation: false };
}

async function rules() {
  const rows = await db.select().from(merchantRules).orderBy(merchantRules.id);
  return rows.map((r) => [r.pattern, r.matchType, r.walletId]);
}

async function pendingTx(type: 'expense' | 'income' | 'refund') {
  const [row] = await db
    .insert(transactions)
    .values({
      amount: 1000,
      merchant: 'corner shop',
      merchantDisplay: 'Corner Shop',
      rawText: 'seed',
      status: 'pending',
      type,
      transactionDate: '2026-03-10T12:00:00.000Z',
    })
    .returning();
  if (!row) throw new Error('pendingTx');
  return row;
}

async function txRow(id: number) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
  return row;
}

// The row as the Telegram Undo handler loads it: with its classifiedAt.
async function classifiedTx(id: number) {
  const row = await txRow(id);
  if (!row?.classifiedAt) throw new Error('classifiedTx: not classified');
  return row;
}

// Fails one step of a multi-step write (TEMP: this connection only).
function failWrites(op: 'INSERT' | 'UPDATE', table: 'merchant_rules' | 'transactions') {
  db.$client.exec(
    `CREATE TEMP TRIGGER fail_write BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'write failed'); END`,
  );
}
