import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { config } from '../config';
import { getClientIp, rateLimitKey } from './client-ip';

const originalTrustProxy = config.TRUST_PROXY;

afterEach(() => {
  config.TRUST_PROXY = originalTrustProxy;
});

describe('getClientIp', () => {
  const app = new Hono().get('/', (c) => c.text(getClientIp(c)));
  // What Bun passes app.fetch as its second argument (see index.ts).
  const bunServer = { requestIP: () => ({ address: '203.0.113.9', family: 'IPv4', port: 1 }) };
  const ipOf = async (headers: Record<string, string>) =>
    (await app.request('/', { headers }, bunServer)).text();

  test('without TRUST_PROXY, uses the socket address and ignores forwarding headers', async () => {
    config.TRUST_PROXY = false;
    expect(
      await ipOf({ 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2' }),
    ).toBe('203.0.113.9');
  });

  test('with TRUST_PROXY, uses cf-connecting-ip', async () => {
    config.TRUST_PROXY = true;
    expect(await ipOf({ 'cf-connecting-ip': '198.51.100.1' })).toBe('198.51.100.1');
  });
});

describe('rateLimitKey', () => {
  test('keys IPv4 by the full address', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
  });

  test('groups every address in one IPv6 /64 under a single key', () => {
    const key = rateLimitKey('2001:db8:dead:beef::1');
    expect(key).toBe('2001:db8:dead:beef::/64');
    expect(rateLimitKey('2001:db8:dead:beef:ffff:ffff:ffff:ffff')).toBe(key);
    expect(rateLimitKey('2001:0DB8:DEAD:BEEF:0:0:0:2')).toBe(key);
    expect(rateLimitKey('2001:db8:dead:bef0::1')).not.toBe(key);
  });

  test('expands compressed prefixes', () => {
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
  });

  test('treats IPv4-mapped IPv6 as the IPv4 client', () => {
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
  });

  test('passes non-IP values through unchanged', () => {
    expect(rateLimitKey('unknown')).toBe('unknown');
  });
});
