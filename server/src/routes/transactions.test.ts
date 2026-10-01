import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { merchantRules, transactions } from '../db/schema';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { invalidateContainsCache } from '../services/classifier';
import { authedHeaders, ensureMigrated, seedWallet, truncateAll } from '../test/db';

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
  invalidateContainsCache();
});

async function seedTx(walletId: number, type: 'expense' | 'income' | 'refund' | 'adjustment') {
  const [row] = await db
    .insert(transactions)
    .values({
      walletId,
      amount: 1500,
      currency: 'EUR',
      merchant: 'mercadona',
      merchantDisplay: 'MERCADONA',
      rawText: 'seed',
      status: 'classified',
      type,
      classifiedAt: '2026-03-01T12:00:00Z',
      transactionDate: '2026-03-01T12:00:00Z',
    })
    .returning();
  if (!row) throw new Error('seedTx');
  return row;
}

describe('POST /api/transactions', () => {
  test('creates a manual expense classified', async () => {
    const w = await seedWallet({ name: 'Food' });
    const res = await app.request('/api/transactions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        walletId: w.id,
        amount: 2500,
        type: 'expense',
        merchantDisplay: 'Amazon',
        transactionDate: '2026-03-15T10:00:00.000Z',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; type: string; status: string };
    expect(body.type).toBe('expense');
    expect(body.status).toBe('classified');

    const [row] = await db.select().from(transactions).where(eq(transactions.id, body.id));
    expect(row?.walletId).toBe(w.id);
    expect(row?.amount).toBe(2500);
    expect(row?.rawText).toBe('manual:expense');
    expect(row?.classifiedAt).not.toBeNull();
  });

  test('creates income with type=income', async () => {
    const w = await seedWallet({ name: 'Salary' });
    const res = await app.request('/api/transactions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        walletId: w.id,
        amount: 200000,
        type: 'income',
        merchantDisplay: 'Payroll',
        transactionDate: '2026-03-25T10:00:00.000Z',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe('income');
  });

  test('refund with valid relatedTxId succeeds', async () => {
    const w = await seedWallet();
    const origin = await seedTx(w.id, 'expense');
    const res = await app.request('/api/transactions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        walletId: w.id,
        amount: 500,
        type: 'refund',
        merchantDisplay: 'MERCADONA',
        transactionDate: '2026-03-02T10:00:00.000Z',
        relatedTxId: origin.id,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { relatedTxId: number | null };
    expect(body.relatedTxId).toBe(origin.id);
  });

  test('refund with missing relatedTxId fails with 400', async () => {
    const w = await seedWallet();
    const res = await app.request('/api/transactions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        walletId: w.id,
        amount: 500,
        type: 'refund',
        merchantDisplay: 'ghost',
        transactionDate: '2026-03-02T10:00:00.000Z',
        relatedTxId: 99999,
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/transactions/:id', () => {
  test('changing walletId on expense creates an exact merchant rule', async () => {
    const w1 = await seedWallet({ name: 'Food' });
    const w2 = await seedWallet({ name: 'Home' });
    const tx = await seedTx(w1.id, 'expense');

    const res = await app.request(`/api/transactions/${tx.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ walletId: w2.id }),
    });
    expect(res.status).toBe(200);

    const rules = await db
      .select()
      .from(merchantRules)
      .where(eq(merchantRules.pattern, 'mercadona'));
    expect(rules.length).toBe(1);
    expect(rules[0]?.walletId).toBe(w2.id);
  });

  test('refund: assigning a wallet does NOT create a merchant rule', async () => {
    const w1 = await seedWallet({ name: 'Food' });
    const w2 = await seedWallet({ name: 'Home' });
    const tx = await seedTx(w1.id, 'refund');

    const res = await app.request(`/api/transactions/${tx.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ walletId: w2.id }),
    });
    expect(res.status).toBe(200);

    const rules = await db.select().from(merchantRules);
    expect(rules.length).toBe(0);
  });

  test('changing type from expense to refund + assigning wallet does NOT create rule', async () => {
    const w1 = await seedWallet({ name: 'Food' });
    const w2 = await seedWallet({ name: 'Home' });
    const tx = await seedTx(w1.id, 'expense');

    const res = await app.request(`/api/transactions/${tx.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ walletId: w2.id, type: 'refund' }),
    });
    expect(res.status).toBe(200);

    const rules = await db.select().from(merchantRules);
    expect(rules.length).toBe(0);

    const [row] = await db.select().from(transactions).where(eq(transactions.id, tx.id));
    expect(row?.type).toBe('refund');
  });

  test('editing a pending tx while leaving wallet unassigned keeps it pending', async () => {
    const [tx] = await db
      .insert(transactions)
      .values({
        walletId: null,
        amount: 1200,
        currency: 'EUR',
        merchant: 'spar',
        merchantDisplay: 'SPAR',
        rawText: 'seed',
        status: 'pending',
        type: 'expense',
        transactionDate: '2026-03-03T09:00:00Z',
      })
      .returning();
    if (!tx) throw new Error('seed failed');

    // The dashboard edit modal always sends walletId — null when the select is "—".
    const res = await app.request(`/api/transactions/${tx.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ walletId: null, description: 'fixed note' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(transactions).where(eq(transactions.id, tx.id));
    expect(row?.status).toBe('pending');
    expect(row?.classifiedAt).toBeNull();
    expect(row?.description).toBe('fixed note');
  });

  test('walletId null returns a classified tx to pending (unassign)', async () => {
    const w = await seedWallet();
    const tx = await seedTx(w.id, 'expense');

    const res = await app.request(`/api/transactions/${tx.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ walletId: null }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(transactions).where(eq(transactions.id, tx.id));
    expect(row?.walletId).toBeNull();
    expect(row?.status).toBe('pending');
    expect(row?.classifiedAt).toBeNull();
  });

  test('walletId null with an explicit status keeps that status', async () => {
    const w = await seedWallet();
    const tx = await seedTx(w.id, 'expense');

    const res = await app.request(`/api/transactions/${tx.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ walletId: null, status: 'ignored' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(transactions).where(eq(transactions.id, tx.id));
    expect(row?.walletId).toBeNull();
    expect(row?.status).toBe('ignored');
  });

  test('relatedTxId pointing at the transaction itself is rejected', async () => {
    const w = await seedWallet();
    const tx = await seedTx(w.id, 'refund');

    const res = await app.request(`/api/transactions/${tx.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ relatedTxId: tx.id }),
    });
    expect(res.status).toBe(400);
  });

  test('patches relatedTxId and rejects non-existent target', async () => {
    const w = await seedWallet();
    const origin = await seedTx(w.id, 'expense');
    const ref = await seedTx(w.id, 'refund');

    const ok = await app.request(`/api/transactions/${ref.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ relatedTxId: origin.id }),
    });
    expect(ok.status).toBe(200);

    const bad = await app.request(`/api/transactions/${ref.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ relatedTxId: 987654 }),
    });
    expect(bad.status).toBe(400);
  });
});
