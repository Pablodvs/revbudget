import { describe, expect, test } from 'bun:test';
import { parseConfig } from './config';

const REQUIRED = {
  DATABASE_URL: './data/test.db',
  WEBHOOK_SECRET: 'w'.repeat(32),
  BETTER_AUTH_SECRET: 'b'.repeat(32),
};

describe('parseConfig', () => {
  test('blank optional values count as unset (Bun/docker env_file load `KEY=` as "")', () => {
    const cfg = parseConfig({
      ...REQUIRED,
      PORT: '',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
      BETTER_AUTH_URL: '',
      BOOTSTRAP_ADMIN_EMAIL: '',
      BOOTSTRAP_ADMIN_PASSWORD: '',
      TRUST_PROXY: '',
      DASHBOARD_ORIGIN: '',
      TRUSTED_ORIGINS: '',
      NODE_ENV: '',
      APP_TIMEZONE: '',
      LOG_NOTIFICATION_TEXT: '',
      OLLAMA_ENABLED: '',
      OLLAMA_URL: '',
      OLLAMA_MODEL: '',
      OLLAMA_TIMEOUT_MS: '',
      DEMO_MODE: '',
    });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.APP_TIMEZONE).toBe('Europe/Madrid');
    expect(cfg.OLLAMA_ENABLED).toBe(true);
    expect(cfg.OLLAMA_URL).toBe('http://localhost:11434');
    expect(cfg.DEMO_MODE).toBe(false);
    expect(cfg.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(cfg.telegram).toBeNull();
    expect(cfg.trustedOrigins).toEqual(['http://localhost:5173']);
  });

  test('Telegram is enabled only when token and chat id are both set', () => {
    const cfg = parseConfig({
      ...REQUIRED,
      TELEGRAM_BOT_TOKEN: '123456:test-token',
      TELEGRAM_CHAT_ID: '-100123',
    });
    expect(cfg.telegram).toEqual({ botToken: '123456:test-token', chatId: -100123 });

    expect(() => parseConfig({ ...REQUIRED, TELEGRAM_BOT_TOKEN: '123456:test-token' })).toThrow(
      /TELEGRAM_CHAT_ID: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID together/,
    );
    expect(() => parseConfig({ ...REQUIRED, TELEGRAM_CHAT_ID: '42' })).toThrow(
      /TELEGRAM_BOT_TOKEN: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID together/,
    );
  });

  test('booleans accept true/1 in any case, and nothing else', () => {
    for (const v of ['true', 'TRUE', 'True', '1']) {
      expect(parseConfig({ ...REQUIRED, TRUST_PROXY: v }).TRUST_PROXY).toBe(true);
      expect(parseConfig({ ...REQUIRED, DEMO_MODE: v }).DEMO_MODE).toBe(true);
    }
    for (const v of ['false', 'FALSE', '0', 'yes']) {
      expect(parseConfig({ ...REQUIRED, TRUST_PROXY: v }).TRUST_PROXY).toBe(false);
      expect(parseConfig({ ...REQUIRED, OLLAMA_ENABLED: v }).OLLAMA_ENABLED).toBe(false);
    }
  });

  test('DEMO_MODE refuses Telegram, even half-configured', () => {
    const telegram = { TELEGRAM_BOT_TOKEN: '123456:test-token', TELEGRAM_CHAT_ID: '-100123' };
    expect(() => parseConfig({ ...REQUIRED, ...telegram, DEMO_MODE: 'true' })).toThrow(
      /DEMO_MODE: leave TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID blank/,
    );
    expect(() =>
      parseConfig({ ...REQUIRED, TELEGRAM_CHAT_ID: '-100123', DEMO_MODE: 'true' }),
    ).toThrow(/DEMO_MODE: leave TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID blank/);
    expect(parseConfig({ ...REQUIRED, ...telegram, DEMO_MODE: 'false' }).telegram).not.toBeNull();
  });

  test('DEMO_MODE turns Ollama off', () => {
    expect(parseConfig({ ...REQUIRED, OLLAMA_ENABLED: 'true' }).OLLAMA_ENABLED).toBe(true);
    const demo = parseConfig({ ...REQUIRED, OLLAMA_ENABLED: 'true', DEMO_MODE: 'true' });
    expect(demo.DEMO_MODE).toBe(true);
    expect(demo.OLLAMA_ENABLED).toBe(false);
  });

  test('rejects the .env.example placeholder secrets', () => {
    const placeholder = 'generate_with_openssl_rand_hex_32_min_32_chars';
    expect(() => parseConfig({ ...REQUIRED, WEBHOOK_SECRET: placeholder })).toThrow(
      /WEBHOOK_SECRET is still the \.env\.example placeholder/,
    );
    expect(() => parseConfig({ ...REQUIRED, BETTER_AUTH_SECRET: placeholder })).toThrow(
      /BETTER_AUTH_SECRET is still the \.env\.example placeholder/,
    );
  });

  test('a blank required secret is reported as missing', () => {
    expect(() => parseConfig({ ...REQUIRED, WEBHOOK_SECRET: '' })).toThrow(
      /WEBHOOK_SECRET: Required/,
    );
  });
});
