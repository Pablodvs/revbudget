import { describe, expect, test } from 'bun:test';
import { parseNotification } from './notification-parser';

const fixedDate = new Date('2026-04-13T10:00:00Z');

describe('parseNotification', () => {
  test('pagaste en LIDL CENTRAL', () => {
    const r = parseNotification('💳 Pagaste 12,50 € en LIDL CENTRAL', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(1250);
    expect(r.value.currency).toBe('EUR');
    expect(r.value.merchant).toBe('lidl central');
    expect(r.value.merchantDisplay).toBe('LIDL CENTRAL');
  });

  test('pagaste en Spotify', () => {
    const r = parseNotification('💳 Pagaste 3,99 € en Spotify', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(399);
    expect(r.value.merchant).toBe('spotify');
  });

  test('enviaste a persona', () => {
    const r = parseNotification('💸 Enviaste 50,00 € a Juan García', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(5000);
    expect(r.value.merchantDisplay).toBe('Juan García');
  });

  test('pagaste con tu tarjeta en SPAR', () => {
    const r = parseNotification('💳 Pagaste 1,20 € con tu tarjeta en SPAR', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(120);
    expect(r.value.merchant).toBe('spar');
  });

  test('non-EUR currency (USD)', () => {
    const r = parseNotification('Pagaste 8,00 USD en NETFLIX', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(800);
    expect(r.value.currency).toBe('USD');
    expect(r.value.merchant).toBe('netflix');
  });

  test('malformed input returns ParseError', () => {
    const r = parseNotification('no soy una notificación', fixedDate);
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
    const r = parseNotification('  💳 Pagaste 4,75 € en Carrefour  \n\n', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(475);
    expect(r.value.merchantDisplay).toBe('Carrefour');
  });

  test('non-breaking space between amount and currency', () => {
    const r = parseNotification('💳 Pagaste 9,99\u00A0€ en Amazon', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(999);
    expect(r.value.merchant).toBe('amazon');
  });

  test('thousands separator (dot)', () => {
    const r = parseNotification('Pagaste 1.234,56 € en MediaMarkt', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe(123456);
  });

  test('normalizes internal whitespace in merchant', () => {
    const r = parseNotification('💳 Pagaste 2,00 € en  LIDL   CENTRAL', fixedDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.merchant).toBe('lidl central');
  });
});
