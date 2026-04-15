import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { config } from '../config';

const expected = Buffer.from(config.API_TOKEN, 'utf8');

export const apiAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const match = header.match(/^Bearer (.+)$/);
  const token = match?.[1] ?? '';
  const provided = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return c.json({ error: 'unauthorized', requestId: c.get('requestId') ?? '' }, 401);
  }
  await next();
};
