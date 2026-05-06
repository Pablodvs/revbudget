import { describe, expect, test } from 'bun:test';
import { parseNotification } from './notification-parser';

const fixedDate = new Date('2026-04-13T10:00:00Z');

describe('parseNotification', () => {
  test('en: You paid €X at Y', () => {
    const r = parseNotification('You paid €5.11 at FreshMart', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('expense');
    expect(r.value.amount).toBe(511);
    expect(r.value.currency).toBe('EUR');
    expect(r.value.merchant).toBe('freshmart');
    expect(r.value.merchantDisplay).toBe('FreshMart');
  });

  test('en: You paid £X at Y (GBP)', () => {
    const r = parseNotification('You paid £11.20 at Smith & Sons', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('expense');
    expect(r.value.amount).toBe(1120);
    expect(r.value.currency).toBe('GBP');
    expect(r.value.merchantDisplay).toBe('Smith & Sons');
  });

  test('en: "Paid" without "You" prefix', () => {
    const r = parseNotification('Paid $8.00 at NETFLIX', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(800);
    expect(r.value.currency).toBe('USD');
    expect(r.value.merchant).toBe('netflix');
  });

  test('malformed input returns ParseError', () => {
    const r = parseNotification('not a notification at all', fixedDate);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('no_match');
  });

  test('empty input returns empty error', () => {
    const r = parseNotification('   \n ', fixedDate);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('empty');
  });

  test('trailing whitespace and newlines', () => {
    const r = parseNotification('  💳 You paid €4.75 at Carrefour  \n\n', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(475);
    expect(r.value.merchantDisplay).toBe('Carrefour');
  });

  test('non-breaking space between amount and currency', () => {
    const r = parseNotification('💳 You paid €\u00A09.99 at Amazon', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(999);
    expect(r.value.merchant).toBe('amazon');
  });

  test('normalizes internal whitespace in merchant', () => {
    const r = parseNotification('💳 You paid €2.00 at  LIDL   CENTRAL', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.merchant).toBe('lidl central');
  });

  test('expense type tag', () => {
    const r = parseNotification('You paid €1.00 at X', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('expense');
  });

  test('income: You received €25.00 from Alice', () => {
    const r = parseNotification('💶 You received €25.00 from Alice', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('income');
    expect(r.value.amount).toBe(2500);
    expect(r.value.currency).toBe('EUR');
    expect(r.value.merchantDisplay).toBe('Alice');
    expect(r.value.merchant).toBe('alice');
  });

  test('income: Received £10.50 from BOB', () => {
    const r = parseNotification('Received £10.50 from BOB', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('income');
    expect(r.value.amount).toBe(1050);
    expect(r.value.currency).toBe('GBP');
    expect(r.value.merchantDisplay).toBe('BOB');
  });

  test('income: John Doe sent you $5.00', () => {
    const r = parseNotification('John Doe sent you $5.00', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('income');
    expect(r.value.amount).toBe(500);
    expect(r.value.currency).toBe('USD');
    expect(r.value.merchantDisplay).toBe('John Doe');
  });

  test('income: integer amount without decimal', () => {
    const r = parseNotification('You received €42 from Alice', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(4200);
  });

  test('refund: You were refunded €12.99 by NETFLIX', () => {
    const r = parseNotification('↩️ You were refunded €12.99 by NETFLIX', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('refund');
    expect(r.value.amount).toBe(1299);
    expect(r.value.merchantDisplay).toBe('NETFLIX');
  });

  test('refund: Refund of €3.00 from SPAR', () => {
    const r = parseNotification('Refund of €3.00 from SPAR', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('refund');
    expect(r.value.amount).toBe(300);
    expect(r.value.merchantDisplay).toBe('SPAR');
  });

  test('refund: AMAZON refunded you €19.90', () => {
    const r = parseNotification('AMAZON refunded you €19.90', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('refund');
    expect(r.value.amount).toBe(1990);
    expect(r.value.merchantDisplay).toBe('AMAZON');
  });

  test("refund: Refund arrived 🎉: You've received a payment refund of €21 from IKEA", () => {
    const r = parseNotification(
      "Refund arrived 🎉: You've received a payment refund of €21 from IKEA",
      fixedDate,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('refund');
    expect(r.value.amount).toBe(2100);
    expect(r.value.currency).toBe('EUR');
    expect(r.value.merchantDisplay).toBe('IKEA');
  });

  test('refund: curly apostrophe variant (You\u2019ve received a payment refund)', () => {
    const r = parseNotification(
      'Refund arrived \ud83c\udf89: You\u2019ve received a payment refund of \u20ac21 from IKEA',
      fixedDate,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('refund');
    expect(r.value.amount).toBe(2100);
    expect(r.value.merchantDisplay).toBe('IKEA');
  });

  test('en: title prefix + balance trailer (real Revolut push)', () => {
    const r = parseNotification(
      'Acme Stores: 🛒 Paid €35.11 at FreshMart\nCredit available: €1,000.00',
      fixedDate,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('expense');
    expect(r.value.amount).toBe(3511);
    expect(r.value.currency).toBe('EUR');
    expect(r.value.merchantDisplay).toBe('FreshMart');
  });

  test('en: dual-currency parenthetical with balance trailer', () => {
    const r = parseNotification(
      '🛍 Paid £11.20 (€12.94) at Smith & Sons\nAvailable credit: €2,000.00',
      fixedDate,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('expense');
    expect(r.value.amount).toBe(1120);
    expect(r.value.currency).toBe('GBP');
    expect(r.value.merchantDisplay).toBe('Smith & Sons');
  });

  test('balance line alone returns no_match, not a false amount', () => {
    const r = parseNotification('Credit available: €1,000.00', fixedDate);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('empty');
  });

  test('en: trailing "with card" suffix is stripped', () => {
    const r = parseNotification('Paid £5.00 at Tesco with card', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('expense');
    expect(r.value.amount).toBe(500);
    expect(r.value.currency).toBe('GBP');
    expect(r.value.merchantDisplay).toBe('Tesco');
  });

  test('en: multi-word trailer after "card" is stripped', () => {
    const r = parseNotification('Paid £5.00 at Tesco with your card visa debit', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('expense');
    expect(r.value.amount).toBe(500);
    expect(r.value.merchantDisplay).toBe('Tesco');
  });

  test('extended balance variants are filtered', () => {
    for (const line of [
      'Available balance: €500.00',
      'Balance: €500.00',
      'Remaining credit: €500.00',
      'Current balance: €500.00',
    ]) {
      const r = parseNotification(line, fixedDate);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('empty');
    }
  });

  test('merchant starting with a digit is preserved', () => {
    const r = parseNotification('3M Corp sent you $5.00', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe('income');
    expect(r.value.merchantDisplay).toBe('3M Corp');
    expect(r.value.amount).toBe(500);
  });

  test('english thousands separator (comma)', () => {
    const r = parseNotification('You received €1,234.56 from BigCorp', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(123456);
    expect(r.value.type).toBe('income');
  });
});
