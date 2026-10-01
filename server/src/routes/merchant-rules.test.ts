import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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

type Rule = {
  id: number;
  pattern: string;
  walletId: number;
  matchType: 'exact' | 'contains';
  requireConfirmation: boolean;
};

async function req(path: string, method = 'GET', body?: unknown) {
  const res = await app.request(`/api/merchant-rules${path}`, {
    method,
    headers: AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('merchant rules CRUD', () => {
  test('POST normalizes the pattern and applies defaults; GET lists it', async () => {
    const w = await seedWallet();
    const created = await req('', 'POST', { pattern: '  Tesco   EXPRESS ', walletId: w.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      pattern: 'tesco express',
      walletId: w.id,
      matchType: 'exact',
      requireConfirmation: true,
    });

    const list = await app.request('/api/merchant-rules', { headers: AUTH });
    expect(((await list.json()) as Rule[]).map((r) => r.pattern)).toEqual(['tesco express']);
  });

  test('a pattern that is taken after normalization is 409 duplicate', async () => {
    const w = await seedWallet();
    expect((await req('', 'POST', { pattern: 'Tesco Express', walletId: w.id })).status).toBe(201);
    const dup = await req('', 'POST', { pattern: 'TESCO  express', walletId: w.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('duplicate');
  });

  test('an unknown walletId is 400 invalid_reference', async () => {
    const res = await req('', 'POST', { pattern: 'lidl', walletId: 999999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_reference');
  });

  test('a too-short contains pattern is a validation error on `pattern`', async () => {
    const w = await seedWallet();
    const res = await req('', 'POST', { pattern: 'ab', walletId: w.id, matchType: 'contains' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'validation_failed', issues: [{ path: 'pattern' }] });
  });

  test('PUT updates fields; renaming onto a taken pattern is 409', async () => {
    const a = await seedWallet({ name: 'A' });
    const b = await seedWallet({ name: 'B' });
    const lidl = (await req('', 'POST', { pattern: 'lidl', walletId: a.id })).body as Rule;
    await req('', 'POST', { pattern: 'aldi', walletId: a.id });

    const updated = await req(`/${lidl.id}`, 'PUT', {
      pattern: ' LIDL Market ',
      walletId: b.id,
      matchType: 'contains',
      requireConfirmation: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      pattern: 'lidl market',
      walletId: b.id,
      matchType: 'contains',
      requireConfirmation: false,
    });

    const clash = await req(`/${lidl.id}`, 'PUT', { pattern: 'ALDI' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('duplicate');
  });

  test('PUT and DELETE on an unknown id are 404 rule_not_found', async () => {
    for (const [method, body] of [
      ['PUT', { requireConfirmation: false }],
      ['DELETE', undefined],
    ] as const) {
      const res = await req('/999999', method, body);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('rule_not_found');
    }
  });
});

describe('merchant rule writes reach the next classification', () => {
  test('create, retarget, narrow and delete a contains rule', async () => {
    const transport = await seedWallet({ name: 'Transport' });
    const food = await seedWallet({ name: 'Food' });

    const rule = (
      await req('', 'POST', {
        pattern: 'uber',
        walletId: transport.id,
        matchType: 'contains',
        requireConfirmation: false,
      })
    ).body as Rule;
    expect((await classifyMerchant('uber eats')).walletId).toBe(transport.id);

    await req(`/${rule.id}`, 'PUT', { walletId: food.id });
    expect((await classifyMerchant('uber eats')).walletId).toBe(food.id);

    await req(`/${rule.id}`, 'PUT', { matchType: 'exact' });
    expect((await classifyMerchant('uber eats')).walletId).toBeNull();
    expect((await classifyMerchant('uber')).walletId).toBe(food.id);

    expect((await req(`/${rule.id}`, 'DELETE')).body).toEqual({ ok: true });
    expect((await classifyMerchant('uber')).walletId).toBeNull();
  });
});
