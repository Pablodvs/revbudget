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
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    window: 60,
    max: 5,
  },
  plugins: [admin()],
});

export type Auth = typeof auth;
