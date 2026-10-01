/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { TransactionCreateSchema, WalletCreateSchema, WalletUpdateSchema } from './schemas';

const baseWallet = { name: 'Food', budget: 35000, color: '#22c55e' };

describe('currency validation', () => {
  test('rejects 3-char values that are not letters', () => {
    for (const junk of ['€12', 'ab1', '1€2', 'EU ']) {
      const r = WalletCreateSchema.safeParse({ ...baseWallet, currency: junk });
      expect(r.success).toBe(false);
    }
  });

  test('accepts any alpha-3 code and uppercases it', () => {
    const r = WalletCreateSchema.parse({ ...baseWallet, currency: 'usd' });
    expect(r.currency).toBe('USD');
  });

  test('defaults to EUR when omitted', () => {
    const r = WalletCreateSchema.parse(baseWallet);
    expect(r.currency).toBe('EUR');
  });

  test('partial update without currency is unaffected', () => {
    const r = WalletUpdateSchema.safeParse({ name: 'Renamed' });
    expect(r.success).toBe(true);
  });

  test('partial update still rejects junk currency', () => {
    const r = WalletUpdateSchema.safeParse({ currency: '€12' });
    expect(r.success).toBe(false);
  });

  test('TransactionCreateSchema uppercases the optional currency', () => {
    const r = TransactionCreateSchema.parse({
      walletId: 1,
      amount: 500,
      type: 'expense',
      merchantDisplay: 'Amazon',
      transactionDate: '2026-03-15T10:00:00.000Z',
      currency: 'gbp',
    });
    expect(r.currency).toBe('GBP');
  });
});
