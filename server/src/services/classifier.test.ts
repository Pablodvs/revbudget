import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../db';
import { merchantRules } from '../db/schema';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { ensureMigrated, seedWallet, truncateAll } from '../test/db';
import {
  classifyMerchant,
  deleteRuleByPattern,
  invalidateContainsCache,
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

describe('upsertExactRule / deleteRuleByPattern', () => {
  test('upsert inserts then updates wallet on duplicate pattern', async () => {
    const a = await seedWallet({ name: 'A' });
    const b = await seedWallet({ name: 'B' });
    await upsertExactRule('netflix', a.id);
    const first = await classifyMerchant('netflix');
    expect(first.walletId).toBe(a.id);
    expect(first.requireConfirmation).toBe(false);

    await upsertExactRule('netflix', b.id);
    const second = await classifyMerchant('netflix');
    expect(second.walletId).toBe(b.id);
    expect(second.requireConfirmation).toBe(false);
  });

  test('deleteRuleByPattern removes classification', async () => {
    const w = await seedWallet({ name: 'A' });
    await upsertExactRule('hbo', w.id);
    expect((await classifyMerchant('hbo')).walletId).toBe(w.id);
    await deleteRuleByPattern('hbo');
    expect((await classifyMerchant('hbo')).walletId).toBeNull();
  });
});
