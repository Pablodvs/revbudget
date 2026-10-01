import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = join(tmpdir(), `revbudget-test-${process.pid}-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

process.env.DATABASE_URL = join(testDir, 'test.db');
// Telegram configured (fake token): suites that reach the notifier mock it, and
// services/telegram-disabled.test.ts covers the unconfigured path.
process.env.TELEGRAM_BOT_TOKEN = '123456789:test-bot-token';
process.env.TELEGRAM_CHAT_ID = '123456789';
process.env.WEBHOOK_SECRET = 'test_secret_must_be_at_least_32_chars_long';
process.env.BETTER_AUTH_SECRET = 'test_better_auth_secret_must_be_at_least_32_chars';
process.env.BETTER_AUTH_URL = 'http://localhost:5173';
process.env.TRUST_PROXY = 'true';
process.env.DASHBOARD_ORIGIN = 'http://localhost:5173';
process.env.NODE_ENV = 'test';
process.env.APP_TIMEZONE = 'Europe/Madrid';
// Pin these so the suite stays hermetic against a developer's local `.env` (Bun
// autoloads it). They're optional in config, and the bootstrap-seed path only runs
// from index.ts (never imported by tests) — fake-but-valid values keep config
// validation deterministic, including the BOOTSTRAP_ADMIN_PASSWORD length floor.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'bootstrap@test.local';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'test-bootstrap-password';
// Off unless a suite turns it on (webhook, ollama-normalizer): nothing may reach
// a developer's real Ollama. No extra origins beyond the two above.
process.env.OLLAMA_ENABLED = 'false';
process.env.TRUSTED_ORIGINS = '';
