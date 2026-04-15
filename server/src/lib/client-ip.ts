import type { Context } from 'hono';
import { config } from '../config';

export function getClientIp(c: Context): string {
  if (config.TRUST_PROXY) {
    return c.req.header('cf-connecting-ip') ?? 'unknown';
  }
  const env = c.env as
    | { server?: { requestIP?: (req: Request) => { address: string } | null } }
    | undefined;
  const info = env?.server?.requestIP?.(c.req.raw);
  return info?.address ?? 'unknown';
}
