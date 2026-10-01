import { Hono } from 'hono';
import { DemoNotificationSchema } from 'shared';
import { clientRateLimitKey } from '../lib/client-ip';
import { validate } from '../lib/validate';
import { rateLimit } from '../middleware/rate-limit';
import { ingestNotification } from '../services/ingest';

type Variables = { requestId: string };

// The demo's stand-in for the Revolut webhook: a signed-in visitor's text takes
// the webhook's pipeline. app.ts serves it only in demo mode, behind a session.
export const demoRoute = new Hono<{ Variables: Variables }>()
  .use(
    '*',
    rateLimit({
      capacity: 20,
      refillPerSecond: 1 / 3,
      keyFn: clientRateLimitKey,
    }),
  )
  .post('/notifications', validate('json', DemoNotificationSchema), async (c) => {
    const { text } = c.req.valid('json');
    const result = await ingestNotification(text, new Date(), c.get('requestId') ?? 'unknown');
    return c.json({ ok: true, ...result });
  });
