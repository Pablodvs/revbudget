import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('without TELEGRAM_* the bot is not built, notifiers no-op, webhooks still store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revbudget-tg-off-'));
  const proc = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, '../test/telegram-disabled.ts')],
    {
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
        OLLAMA_ENABLED: 'false',
        DATABASE_URL: join(dir, 'test.db'),
      },
    },
  );
  expect(proc.exitCode).toBe(0);
  const lastLine = proc.stdout.toString().trim().split('\n').at(-1) ?? '';
  expect(JSON.parse(lastLine)).toEqual({
    telegram: null,
    webhook: { status: 200, body: { ok: true, status: 'pending' } },
    stored: [{ amount: 1250, status: 'pending' }],
    notifiers: [null, null, null, null],
  });
});
