/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { formatCents, formatDateTime, formatMonth, toZonedYearMonth } from './format';

describe('formatCents', () => {
  test('formats cents with the wallet currency', () => {
    expect(formatCents(123456, 'EUR')).toBe('€1,234.56');
    expect(formatCents(-500, 'EUR')).toBe('-€5.00');
  });

  test('falls back instead of throwing on a malformed persisted currency', () => {
    expect(formatCents(1234, '€12')).toBe('12.34 €12');
  });
});

describe('formatDateTime', () => {
  test('renders in the app timezone, not UTC', () => {
    // 22:30Z on 30 Sep is already 1 Oct in Madrid (UTC+2 in summer).
    expect(formatDateTime('2026-09-30T22:30:00.000Z')).toMatch(/^01 Oct(ober)?, 00:30$/);
  });
});

describe('formatMonth', () => {
  test('spells out the month', () => {
    expect(formatMonth('2026-09')).toBe('September 2026');
    expect(formatMonth('2026-01', 'short')).toBe('Jan 2026');
  });

  test('passes malformed input through', () => {
    expect(formatMonth('bogus')).toBe('bogus');
  });
});

describe('toZonedYearMonth', () => {
  test('reads the month in the given timezone', () => {
    expect(toZonedYearMonth('2026-09-30T22:30:00.000Z', 'Europe/Madrid')).toBe('2026-10');
    expect(toZonedYearMonth('2026-09-30T22:30:00.000Z', 'America/New_York')).toBe('2026-09');
  });

  // /api/stats/trends calls it once per transaction: building a formatter per
  // call made 20k rows take over 3 s.
  test('reads many months quickly', () => {
    const start = performance.now();
    for (let i = 0; i < 20_000; i++) {
      toZonedYearMonth(new Date(i * 3_600_000).toISOString(), 'Europe/Madrid');
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
