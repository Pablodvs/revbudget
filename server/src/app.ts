import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config';
import { apiAuth } from './middleware/api-auth';
import { errorHandler, requestId } from './middleware/error-handler';
import { merchantRulesRoute } from './routes/merchant-rules';
import { statsRoute } from './routes/stats';
import { transactionsRoute } from './routes/transactions';
import { walletsRoute } from './routes/wallets';
import { webhookRoute } from './routes/webhook';

type Variables = {
  requestId: string;
};

export const app = new Hono<{ Variables: Variables }>()
  .use('*', requestId)
  .use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }))
  .use(
    '/api/*',
    cors({
      origin: config.DASHBOARD_ORIGIN,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Secret'],
      credentials: false,
    }),
  )
  .use('/api/wallets/*', apiAuth)
  .use('/api/transactions/*', apiAuth)
  .use('/api/merchant-rules/*', apiAuth)
  .use('/api/stats/*', apiAuth)
  .route('/api/webhook', webhookRoute)
  .route('/api/wallets', walletsRoute)
  .route('/api/transactions', transactionsRoute)
  .route('/api/merchant-rules', merchantRulesRoute)
  .route('/api/stats', statsRoute)
  .get('/api/health', (c) => c.json({ ok: true }));

app.onError(errorHandler);

export type AppType = typeof app;
