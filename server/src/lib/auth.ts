import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins';
import { config } from '../config';
import { db } from '../db';
import { CLIENT_IP_HEADER } from './client-ip';

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite' }),
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL ?? config.DASHBOARD_ORIGIN,
  trustedOrigins: config.trustedOrigins,
  advanced: {
    // Secure + __Secure- prefix in production regardless of the base URL's scheme.
    // Elsewhere undefined, not false: better-auth then infers it from the URL, so
    // an https base URL still gets Secure cookies. Runtime config gate for the
    // same reason as rateLimit.enabled below.
    useSecureCookies: config.NODE_ENV === 'production' ? true : undefined,
    // Key the rate limiter on getClientIp's answer (cf-connecting-ip only under
    // TRUST_PROXY, else the socket address). better-auth's default is
    // x-forwarded-for: empty through cloudflared, and client-supplied otherwise.
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    disableSignUp: true,
    minPasswordLength: 12,
  },
  session: {
    // A week, slid forward at most once a day while in use.
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    // `bun build` inlines process.env.NODE_ENV at build time, and the Docker build
    // stage baked "development" into the bundle — so better-auth's own production
    // check (its `enabled` default) reads false in the image and the limiter stays
    // off. Gate on the app's runtime config (read dynamically, never inlined).
    enabled: config.NODE_ENV === 'production',
    // The global window/max pair does NOT govern sign-in: better-auth applies its
    // built-in special rules (sign-in*/sign-up*/change-password*: 3 per 10s) after
    // it. A strict global pair therefore only throttled benign paths — get-session
    // fires on every page load, so 60/5 was 429ing a user with a few tabs open.
    window: 60,
    max: 100,
    customRules: {
      // customRules is the one knob that overrides the built-in special rule.
      // 5/min is stricter over a minute than the default's 3-per-10s bursts.
      '/sign-in/email': { window: 60, max: 5 },
    },
  },
  plugins: [admin()],
});

export type Auth = typeof auth;
