import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config';
import { auth } from './lib/auth';
import { CLIENT_IP_HEADER, clientRateLimitKey, getClientIp } from './lib/client-ip';
import { errorHandler, requestId } from './middleware/error-handler';
import { rateLimit } from './middleware/rate-limit';
import { type SessionRow, type SessionUser, requireSession } from './middleware/require-session';
import { demoRoute } from './routes/demo';
import { merchantRulesRoute } from './routes/merchant-rules';
import { metaRoute } from './routes/meta';
import { statsRoute } from './routes/stats';
import { transactionsRoute } from './routes/transactions';
import { walletsRoute } from './routes/wallets';
import { webhookRoute } from './routes/webhook';

type Variables = {
  requestId: string;
  user?: SessionUser;
  session?: SessionRow;
};

const notFound = (c: Context<{ Variables: Variables }>) =>
  c.json({ error: 'not_found', requestId: c.get('requestId') }, 404);

// All a demo visitor needs from better-auth. Anything else on the published
// login (change-password, update-user, the admin plugin...) would let one
// visitor take the demo away from the next.
const DEMO_AUTH_ALLOWED = new Set([
  'POST /api/auth/sign-in/email',
  'POST /api/auth/sign-out',
  'GET /api/auth/get-session',
]);

// A demo visitor's writes, all routes together: 30 at once, then one per 2 s.
// The row caps in services/demo.ts hold against many visitors.
const demoWriteLimit = rateLimit({ capacity: 30, refillPerSecond: 0.5, keyFn: clientRateLimitKey });
const demoWrites: MiddlewareHandler = (c, next) =>
  config.DEMO_MODE && ['POST', 'PUT', 'DELETE'].includes(c.req.method)
    ? demoWriteLimit(c, next)
    : next();

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
  // Every API response is per-user or per-request: never cache it anywhere.
  .use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  })
  // Registered before the better-auth handler, which otherwise parses any body
  // size pre-authentication. Legitimate bodies are a few KB at most (the webhook
  // caps its text at 4096 chars).
  .use(
    '/api/*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: 'payload_too_large', requestId: c.get('requestId') }, 413),
    }),
  )
  .on(['GET', 'POST'], '/api/auth/*', (c) => {
    // Checked on the path better-auth will route (WHATWG URL parsing), not
    // Hono's: the two disagree on odd request lines such as backslashes.
    const authPath = new URL(c.req.url).pathname;
    if (config.DEMO_MODE && !DEMO_AUTH_ALLOWED.has(`${c.req.method} ${authPath}`)) {
      return c.json({ error: 'demo_locked', requestId: c.get('requestId') }, 403);
    }
    // Overwrites any client-sent value: better-auth's rate limiter keys on it.
    c.req.raw.headers.set(CLIENT_IP_HEADER, getClientIp(c));
    return auth.handler(c.req.raw);
  })
  .route('/api/meta', metaRoute)
  // Outside demo mode the demo's routes are unknown paths, answered before the
  // session check so a real instance doesn't reveal them.
  .use('/api/demo/*', async (c, next) => (config.DEMO_MODE ? next() : notFound(c)))
  .use('/api/demo/*', requireSession)
  .use('/api/wallets/*', requireSession)
  .use('/api/transactions/*', requireSession)
  .use('/api/merchant-rules/*', requireSession)
  .use('/api/stats/*', requireSession)
  .use('/api/wallets/*', demoWrites)
  .use('/api/transactions/*', demoWrites)
  .use('/api/merchant-rules/*', demoWrites)
  .route('/api/webhook', webhookRoute)
  .route('/api/wallets', walletsRoute)
  .route('/api/transactions', transactionsRoute)
  .route('/api/merchant-rules', merchantRulesRoute)
  .route('/api/stats', statsRoute)
  .route('/api/demo', demoRoute)
  .get('/api/health', (c) => c.json({ ok: true }));

// JSON 404 for unknown API paths. Registered at module-eval time so it precedes
// the SPA fallback index.ts adds in production — otherwise GET /api/<typo> would
// serve index.html with a 200. Statement form (not chained) keeps AppType, and
// with it the dashboard's Hono RPC client types, untouched.
app.all('/api/*', notFound);

app.onError(errorHandler);

export type AppType = typeof app;
