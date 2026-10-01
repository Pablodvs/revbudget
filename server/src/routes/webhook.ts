import { Hono } from 'hono';
import { WebhookBodySchema } from 'shared';
import { clientRateLimitKey } from '../lib/client-ip';
import { validate } from '../lib/validate';
import { rateLimit } from '../middleware/rate-limit';
import { webhookSecret } from '../middleware/webhook-secret';
import { ingestNotification } from '../services/ingest';

type Variables = { requestId: string };

export const webhookRoute = new Hono<{ Variables: Variables }>()
  // Rate limit first so bad-secret floods are throttled too (and the
  // timing-safe compare in webhookSecret sits behind the limiter).
  .use(
    '*',
    rateLimit({
      capacity: 60,
      refillPerSecond: 1,
      keyFn: clientRateLimitKey,
    }),
  )
  .use('*', webhookSecret)
  .post('/revolut', validate('json', WebhookBodySchema), async (c) => {
    const body = c.req.valid('json');
    const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
    const { status } = await ingestNotification(
      body.text,
      receivedAt,
      c.get('requestId') ?? 'unknown',
    );
    return c.json({ ok: true, status });
  });
