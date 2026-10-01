import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import { db } from '../db';
import { merchantRules, transactions } from '../db/schema';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { classifyMerchant, invalidateContainsCache } from '../services/classifier';
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

afterEach(() => {
  setSystemTime();
});

function req(path: string, method = 'GET', body?: unknown) {
  return app.request(`/api/wallets${path}`, {
    method,
    headers: AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type TxStatus = 'pending' | 'pending_confirmation' | 'classified' | 'ignored';

async function seedTx(walletId: number | null, status: TxStatus, amount = 1000) {
  const [row] = await db
    .insert(transactions)
    .values({
      walletId,
      amount,
      merchant: 'corner shop',
      merchantDisplay: 'Corner Shop',
      rawText: 'seed',
      status,
      classifiedAt: status === 'classified' ? '2026-03-10T12:00:00.000Z' : null,
      transactionDate: '2026-03-10T12:00:00.000Z',
    })
    .returning();
  if (!row) throw new Error('seedTx');
  return row;
}

describe('wallets CRUD', () => {
  test('POST creates with defaults, GET lists and fetches by id', async () => {
    const created = await req('', 'POST', { name: 'Food', budget: 35000, color: '#22c55e' });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: number; currency: string; isActive: boolean };
    expect(wallet.currency).toBe('EUR');
    expect(wallet.isActive).toBe(true);

    const list = (await (await req('')).json()) as Array<{ id: number }>;
    expect(list.map((w) => w.id)).toEqual([wallet.id]);

    const one = await req(`/${wallet.id}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { name: string }).name).toBe('Food');
  });

  test('POST rejects an invalid body with the validation contract', async () => {
    const res = await req('', 'POST', { name: '', budget: -1, color: 'green' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Array<{ path: string }> };
    expect(body.error).toBe('validation_failed');
    expect(body.issues.map((i) => i.path).sort()).toEqual(['budget', 'color', 'name']);
  });

  test('PUT updates, and unknown ids are 404 wallet_not_found', async () => {
    const w = await seedWallet({ name: 'Food', budget: 1000 });
    const res = await req(`/${w.id}`, 'PUT', { name: 'Groceries', budget: 2000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Groceries', budget: 2000 });

    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { name: 'X' }],
      ['DELETE', undefined],
    ] as const) {
      const missing = await req('/999999', method, body);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toBe('wallet_not_found');
    }
  });

  test('a non-numeric id is a validation error, not a 500', async () => {
    const res = await req('/abc');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('validation_failed');
  });
});

describe('DELETE /api/wallets/:id', () => {
  test("returns the wallet's transactions to the pending queue", async () => {
    const doomed = await seedWallet({ name: 'Doomed' });
    const kept = await seedWallet({ name: 'Kept' });
    const classified = await seedTx(doomed.id, 'classified');
    const suggested = await seedTx(doomed.id, 'pending_confirmation');
    const ignored = await seedTx(doomed.id, 'ignored');
    const other = await seedTx(kept.id, 'classified');
    await db.insert(merchantRules).values({ pattern: 'corner shop', walletId: doomed.id });

    const res = await req(`/${doomed.id}`, 'DELETE');
    expect(res.status).toBe(200);

    const byId = new Map((await db.select().from(transactions)).map((t) => [t.id, t]));
    for (const id of [classified.id, suggested.id]) {
      expect(byId.get(id)).toMatchObject({ walletId: null, status: 'pending', classifiedAt: null });
    }
    expect(byId.get(ignored.id)).toMatchObject({ walletId: null, status: 'ignored' });
    expect(byId.get(other.id)).toMatchObject({ walletId: kept.id, status: 'classified' });
    expect(await db.select().from(merchantRules)).toEqual([]);

    const pending = await app.request('/api/transactions?status=pending', { headers: AUTH });
    const pendingIds = ((await pending.json()) as Array<{ id: number }>).map((t) => t.id);
    expect(pendingIds.sort()).toEqual([classified.id, suggested.id].sort());
  });

  test('a cached contains rule for the deleted wallet stops matching', async () => {
    const w = await seedWallet({ name: 'Groceries' });
    const rule = await app.request('/api/merchant-rules', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ pattern: 'mercado', walletId: w.id, matchType: 'contains' }),
    });
    expect(rule.status).toBe(201);
    expect((await classifyMerchant('mercado central')).walletId).toBe(w.id); // warms the cache

    expect((await req(`/${w.id}`, 'DELETE')).status).toBe(200);

    // A stale hit here made the webhook insert a transaction into the deleted
    // wallet: FK violation, 500, notification lost.
    expect(await classifyMerchant('mercado central')).toMatchObject({
      walletId: null,
      wallet: null,
    });
  });
});

describe('PUT /api/wallets/:id', () => {
  test('refreshes the wallet cached alongside contains rules', async () => {
    const w = await seedWallet({ name: 'Food' });
    await db
      .insert(merchantRules)
      .values({ pattern: 'mercado', walletId: w.id, matchType: 'contains' });
    expect((await classifyMerchant('mercado central')).wallet?.name).toBe('Food');

    expect((await req(`/${w.id}`, 'PUT', { name: 'Groceries' })).status).toBe(200);
    expect((await classifyMerchant('mercado central')).wallet?.name).toBe('Groceries');
  });
});

describe('archived wallets in stats', () => {
  test('monthly stats keep an archived wallet for months it has activity in', async () => {
    const archived = await seedWallet({ name: 'Old', budget: 5000 });
    await seedWallet({ name: 'Idle', budget: 7000, isActive: false });
    await seedTx(archived.id, 'classified', 1234);
    expect((await req(`/${archived.id}`, 'PUT', { isActive: false })).status).toBe(200);

    const res = await app.request('/api/stats/monthly?month=2026-03', { headers: AUTH });
    const body = (await res.json()) as {
      totalSpent: number;
      totalBudget: number;
      perWallet: Array<{ walletName: string }>;
    };
    expect(body.totalSpent).toBe(1234);
    expect(body.totalBudget).toBe(5000);
    expect(body.perWallet.map((w) => w.walletName)).toEqual(['Old']);
  });

  test('trends keep an archived wallet that has spend in the window', async () => {
    setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
    const archived = await seedWallet({ name: 'Old', isActive: false });
    await seedWallet({ name: 'Idle', isActive: false });
    await seedTx(archived.id, 'classified', 1234);

    const res = await app.request('/api/stats/trends', { headers: AUTH });
    const body = (await res.json()) as {
      series: Array<{ walletName: string; values: number[] }>;
    };
    expect(body.series.map((s) => [s.walletName, s.values.at(-1)])).toEqual([['Old', 1234]]);
  });
});
