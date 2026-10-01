/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { formatCents } from './format';

describe('formatCents', () => {
  test('formats cents with the wallet currency', () => {
    expect(formatCents(123456, 'EUR')).toContain('1234,56');
  });

  test('falls back instead of throwing on a malformed persisted currency', () => {
    expect(formatCents(1234, '€12')).toBe('12.34 €12');
  });
});
