import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { config } from '../config';

const expected = Buffer.from(config.WEBHOOK_SECRET, 'utf8');

export const webhookSecret: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('x-webhook-secret') ?? '';
  const provided = Buffer.from(header, 'utf8');
  if (provided.length !== expected.length) {
    return c.json({ error: 'unauthorized', requestId: c.get('requestId') ?? '' }, 401);
  }
  if (!timingSafeEqual(provided, expected)) {
    return c.json({ error: 'unauthorized', requestId: c.get('requestId') ?? '' }, 401);
  }
  await next();
};
