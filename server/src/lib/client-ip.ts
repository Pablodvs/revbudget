import { isIPv6 } from 'node:net';
import type { Context } from 'hono';
import {
  convertIPv4BinaryToString,
  convertIPv4MappedIPv6ToIPv4,
  convertIPv6ToBinary,
  isIPv4MappedIPv6,
} from 'hono/utils/ipaddr';
import { config } from '../config';

// Set by app.ts on every better-auth request to what getClientIp resolved
// (overwriting any client-sent value), and the only header lib/auth.ts reads.
export const CLIENT_IP_HEADER = 'x-revbudget-client-ip';

export function getClientIp(c: Context): string {
  if (config.TRUST_PROXY) {
    return c.req.header('cf-connecting-ip') ?? 'unknown';
  }
  // index.ts hands app.fetch to Bun, which passes its Server as the env.
  const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
  return server?.requestIP?.(c.req.raw)?.address ?? 'unknown';
}

// Rate-limit bucket key for an address. One IPv6 subscriber is routinely handed a
// whole /64, so per-address keys would let a single host mint unlimited fresh
// buckets: group by the /64. IPv4-mapped IPv6 (::ffff:a.b.c.d) is its IPv4 client.
export function rateLimitKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const bin = convertIPv6ToBinary(ip);
  if (isIPv4MappedIPv6(bin)) return convertIPv4BinaryToString(convertIPv4MappedIPv6ToIPv4(bin));
  const hextets = [112n, 96n, 80n, 64n].map((shift) => ((bin >> shift) & 0xffffn).toString(16));
  return `${hextets.join(':')}::/64`;
}

export function clientRateLimitKey(c: Context): string {
  return rateLimitKey(getClientIp(c));
}
