import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_CHAT_ID: z.coerce.number().int(),
  WEBHOOK_SECRET: z.string().min(32, 'WEBHOOK_SECRET must be at least 32 chars'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 chars'),
  BETTER_AUTH_URL: z.string().url().optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  TRUST_PROXY: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1')),
  DASHBOARD_ORIGIN: z.string().url().default('http://localhost:5173'),
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
  OLLAMA_ENABLED: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1')),
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen2.5:3b'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

export type AppConfig = z.infer<typeof EnvSchema> & { trustedOrigins: string[] };

function load(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    console.error(`\n[config] Invalid environment variables:\n${issues}\n`);
    process.exit(1);
  }
  const data = parsed.data;
  // better-auth implicitly trusts its own baseURL; mirror that for Hono CORS so the
  // public origin (the tunnel host) is trusted even if DASHBOARD_ORIGIN wasn't set to it.
  const authOrigin = data.BETTER_AUTH_URL ? [new URL(data.BETTER_AUTH_URL).origin] : [];
  const trustedOrigins = Array.from(
    new Set([data.DASHBOARD_ORIGIN, ...authOrigin, ...data.TRUSTED_ORIGINS]),
  );
  return { ...data, trustedOrigins };
}

export const config: AppConfig = load();
