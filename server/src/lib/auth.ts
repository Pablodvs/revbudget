import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins';
import { config } from '../config';
import { db } from '../db';

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite' }),
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL ?? config.DASHBOARD_ORIGIN,
  trustedOrigins: config.trustedOrigins,
  // Behind Cloudflare the real client IP is in `cf-connecting-ip`; better-auth's
  // default (`x-forwarded-for`) is empty through cloudflared, so it can't key the
  // rate limiter and silently skips it. Mirror getClientIp's TRUST_PROXY gating.
  ...(config.TRUST_PROXY
    ? { advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } } }
    : {}),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    disableSignUp: true,
    minPasswordLength: 12,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    // `bun build` inlines process.env.NODE_ENV at build time, and the Docker build
    // stage baked "development" into the bundle — so better-auth's own production
    // check (its `enabled` default) reads false in the image and the limiter stays
    // off. Gate on the app's runtime config (read dynamically, never inlined).
    enabled: config.NODE_ENV === 'production',
    window: 60,
    max: 5,
  },
  plugins: [admin()],
});

export type Auth = typeof auth;
