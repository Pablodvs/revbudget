import { z } from 'zod';

// A secret that still reads like .env.example's instructions would be public.
const Secret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 chars`)
    .refine(
      (v) => !v.startsWith('generate_with'),
      `${name} is still the .env.example placeholder; generate one with: openssl rand -hex 32`,
    );

// Bun and docker `env_file` load `KEY=` as "", which would fail every optional
// field's validation (and skip its default). Blank means unset.
const withoutBlanks = (env: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));

// "true" or "1", in any case; anything else is false.
const Bool = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(fallback)
    .transform((v) => (typeof v === 'boolean' ? v : ['true', '1'].includes(v.toLowerCase())));

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    // Optional as a pair: without them the bot isn't started and notifications
    // are only stored (see services/telegram.ts).
    TELEGRAM_BOT_TOKEN: z.string().min(10).optional(),
    TELEGRAM_CHAT_ID: z.coerce.number().int().optional(),
    WEBHOOK_SECRET: Secret('WEBHOOK_SECRET'),
    BETTER_AUTH_SECRET: Secret('BETTER_AUTH_SECRET'),
    BETTER_AUTH_URL: z.string().url().optional(),
    BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
    TRUST_PROXY: Bool(false),
    // No default here: localhost must never be a trusted origin in production.
    // load() applies the dev default for non-production environments.
    DASHBOARD_ORIGIN: z.string().url().optional(),
    TRUSTED_ORIGINS: z
      .string()
      .optional()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().url())),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    APP_TIMEZONE: z.string().default('Europe/Madrid'),
    // Include raw notification text (financial PII) in ollama-normalizer logs.
    LOG_NOTIFICATION_TEXT: Bool(false),
    OLLAMA_ENABLED: Bool(true),
    OLLAMA_URL: z.string().url().default('http://localhost:11434'),
    OLLAMA_MODEL: z.string().default('qwen2.5:3b'),
    OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    // Public demo instance: fake data, a published login, a nightly reset.
    DEMO_MODE: Bool(false),
  })
  .superRefine((data, ctx) => {
    if ((data.TELEGRAM_BOT_TOKEN === undefined) !== (data.TELEGRAM_CHAT_ID === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [data.TELEGRAM_BOT_TOKEN === undefined ? 'TELEGRAM_BOT_TOKEN' : 'TELEGRAM_CHAT_ID'],
        message:
          'set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID together, or leave both blank to run without the Telegram bot',
      });
    }
    const telegramSet =
      data.TELEGRAM_BOT_TOKEN !== undefined || data.TELEGRAM_CHAT_ID !== undefined;
    if (data.DEMO_MODE && telegramSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEMO_MODE'],
        message:
          'leave TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID blank: anyone can use a demo, and it must never message a real chat',
      });
    }
    if (data.NODE_ENV === 'production' && !data.DASHBOARD_ORIGIN && !data.BETTER_AUTH_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DASHBOARD_ORIGIN'],
        message:
          'required in production (or set BETTER_AUTH_URL): the public https origin the dashboard is served from',
      });
    }
  });

export type AppConfig = z.infer<typeof EnvSchema> & {
  trustedOrigins: string[];
  telegram: { botToken: string; chatId: number } | null;
};

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  const data = parsed.data;
  // Dev/test convenience default only — production must be explicit (superRefine
  // above guarantees DASHBOARD_ORIGIN or BETTER_AUTH_URL is set there).
  const dashboardOrigin =
    data.DASHBOARD_ORIGIN ?? (data.NODE_ENV !== 'production' ? 'http://localhost:5173' : undefined);
  // better-auth implicitly trusts its own baseURL; mirror that for Hono CORS so the
  // public origin (the tunnel host) is trusted even if DASHBOARD_ORIGIN wasn't set to it.
  const authOrigin = data.BETTER_AUTH_URL ? [new URL(data.BETTER_AUTH_URL).origin] : [];
  const trustedOrigins = Array.from(
    new Set([
      ...(dashboardOrigin ? [dashboardOrigin] : []),
      ...authOrigin,
      ...data.TRUSTED_ORIGINS,
    ]),
  );
  const telegram =
    data.TELEGRAM_BOT_TOKEN !== undefined && data.TELEGRAM_CHAT_ID !== undefined
      ? { botToken: data.TELEGRAM_BOT_TOKEN, chatId: data.TELEGRAM_CHAT_ID }
      : null;
  return {
    ...data,
    // A demo's visitors write the notifications: they must never reach a model.
    OLLAMA_ENABLED: data.OLLAMA_ENABLED && !data.DEMO_MODE,
    DASHBOARD_ORIGIN: dashboardOrigin,
    trustedOrigins,
    telegram,
  };
}

function load(): AppConfig {
  try {
    return parseConfig(process.env);
  } catch (err) {
    console.error(`\n[config] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

export const config: AppConfig = load();
