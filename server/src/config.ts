import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_CHAT_ID: z.coerce.number().int(),
  WEBHOOK_SECRET: z.string().min(32, 'WEBHOOK_SECRET must be at least 32 chars'),
  API_TOKEN: z.string().min(32, 'API_TOKEN must be at least 32 chars'),
  TRUST_PROXY: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1')),
  DASHBOARD_ORIGIN: z.string().url().default('http://localhost:5173'),
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

export type AppConfig = z.infer<typeof EnvSchema>;

function load(): AppConfig {
  const parsed = EnvSchema.safeParse(Bun.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    console.error(`\n[config] Invalid environment variables:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const config: AppConfig = load();
