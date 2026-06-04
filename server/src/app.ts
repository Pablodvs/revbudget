import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config';
import { auth } from './lib/auth';
import { errorHandler, requestId } from './middleware/error-handler';
import { type SessionRow, type SessionUser, requireSession } from './middleware/require-session';
import { merchantRulesRoute } from './routes/merchant-rules';
import { statsRoute } from './routes/stats';
import { transactionsRoute } from './routes/transactions';
import { walletsRoute } from './routes/wallets';
import { webhookRoute } from './routes/webhook';

type Variables = {
  requestId: string;
  user?: SessionUser;
  session?: SessionRow;
};

export const app = new Hono<{ Variables: Variables }>()
  .use('*', requestId)
  .use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }))
  .use(
    '/api/*',
    cors({
      origin: config.trustedOrigins,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Secret'],
      credentials: false,
    }),
  )
  .on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  .use('/api/wallets/*', requireSession)
  .use('/api/transactions/*', requireSession)
  .use('/api/merchant-rules/*', requireSession)
  .use('/api/stats/*', requireSession)
  .route('/api/webhook', webhookRoute)
  .route('/api/wallets', walletsRoute)
  .route('/api/transactions', transactionsRoute)
  .route('/api/merchant-rules', merchantRulesRoute)
  .route('/api/stats', statsRoute)
  .get('/api/health', (c) => c.json({ ok: true }));

app.onError(errorHandler);

export type AppType = typeof app;
