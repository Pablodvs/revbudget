import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins';

// CLI-only auth instance used by `bunx better-auth generate`. The CLI's jiti
// loader can't resolve `bun:sqlite`, so we cannot import the real `db`. Schema
// generation introspects plugins/options without issuing SQL — a noop db
// satisfies the adapter type long enough for the generator to run.
// biome-ignore lint/suspicious/noExplicitAny: schema-gen-only shim
const noopDb = {} as any;

export const auth = betterAuth({
  database: drizzleAdapter(noopDb, { provider: 'sqlite' }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    disableSignUp: true,
  },
  plugins: [admin()],
});
