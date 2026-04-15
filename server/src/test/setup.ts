import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = join(tmpdir(), `revbudget-test-${process.pid}-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

process.env.DATABASE_URL = join(testDir, 'test.db');
process.env.TELEGRAM_BOT_TOKEN = '0000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.TELEGRAM_CHAT_ID = '123456789';
process.env.WEBHOOK_SECRET = 'test_secret_must_be_at_least_32_chars_long';
process.env.API_TOKEN = 'test_api_token_must_be_at_least_32_chars_long';
process.env.TRUST_PROXY = 'true';
process.env.DASHBOARD_ORIGIN = 'http://localhost:5173';
process.env.NODE_ENV = 'test';
process.env.APP_TIMEZONE = 'Europe/Madrid';
