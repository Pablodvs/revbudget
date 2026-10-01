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

// Gate on config.NODE_ENV (read at runtime) — `bun build` inlines
// process.env.NODE_ENV at build time (see the rateLimit note in lib/auth.ts).
const isProd = config.NODE_ENV === 'production';

export const app = new Hono<{ Variables: Variables }>()
  .use('*', requestId)
  // No crossOriginResourcePolicy override: Hono's default ('same-origin') is
  // correct — nothing embeds this app's resources cross-origin, and CORP does
  // not affect the dashboard's CORS-mode fetches.
  .use(
    '*',
    secureHeaders(
      isProd
        ? {
            // Backstop CSP for the internet-exposed SPA (no v-html anywhere; this
            // contains a future XSS, it doesn't patch a live one). Prod-only: the
            // Vite dev server needs eval/HMR and serves the SPA itself anyway.
            contentSecurityPolicy: {
              defaultSrc: ["'self'"],
              baseUri: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
              formAction: ["'self'"],
              scriptSrc: ["'self'"],
              connectSrc: ["'self'"],
              // Vite inlines assets under 4KB as data: URLs.
              imgSrc: ["'self'", 'data:'],
              // 'unsafe-inline' is load-bearing: vue-echarts appends a <style>
              // (x-vue-echarts sizing rule) at module load; blocking it silently
              // collapses every chart. Its new Function probe is try/caught, so
              // no 'unsafe-eval' is needed (one benign console report on Stats).
              styleSrc: ["'self'", "'unsafe-inline'"],
              fontSrc: ["'self'"],
            },
          }
        : {},
    ),
  )
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

// JSON 404 for unknown API paths. Registered at module-eval time so it precedes
// the SPA fallback index.ts adds in production — otherwise GET /api/<typo> would
// serve index.html with a 200. Statement form (not chained) keeps AppType, and
// with it the dashboard's Hono RPC client types, untouched.
app.all('/api/*', (c) => c.json({ error: 'not_found', requestId: c.get('requestId') }, 404));

app.onError(errorHandler);

export type AppType = typeof app;
