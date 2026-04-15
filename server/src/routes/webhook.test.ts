import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const sendClassifyPrompt = mock(async (_tx: unknown) => 1001);
const sendConfirmation = mock(async (_tx: unknown) => undefined);
const sendParseFailedPrompt = mock(async (_pf: unknown) => 2002);

mock.module('../services/telegram', () => ({
  bot: { api: { getChat: async () => ({ id: 123, type: 'private' }) } },
  sendClassifyPrompt,
  sendConfirmation,
  sendParseFailedPrompt,
}));

const { app } = await import('../app');
const { db } = await import('../db');
const { merchantRules, parseFailures, transactions } = await import('../db/schema');
const { invalidateContainsCache } = await import('../services/classifier');
const { ensureMigrated, seedWallet, truncateAll } = await import('../test/db');
const { stopRateLimitSweeper } = await import('../middleware/rate-limit');

const WEBHOOK_SECRET = 'test_secret_must_be_at_least_32_chars_long';

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
});

beforeEach(async () => {
  await truncateAll();
  invalidateContainsCache();
  sendClassifyPrompt.mockClear();
  sendConfirmation.mockClear();
  sendParseFailedPrompt.mockClear();
});

function postWebhook(body: unknown, secret = WEBHOOK_SECRET) {
  return app.request('/api/webhook/revolut', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': secret,
      'cf-connecting-ip': `10.${Math.floor(Math.random() * 255)}.0.1`,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/webhook/revolut', () => {
  test('rejects missing secret with 401', async () => {
    const res = await app.request('/api/webhook/revolut', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Pagaste 12,00 € en Mercadona' }),
    });
    expect(res.status).toBe(401);
  });

  test('rejects wrong secret with 401', async () => {
    const res = await postWebhook(
      { text: 'Pagaste 12,00 € en Mercadona' },
      'wrong_secret_padded_to_over_32_chars_xxxx',
    );
    expect(res.status).toBe(401);
  });

  test('classified path: matching rule inserts transaction and sends confirmation', async () => {
    const wallet = await seedWallet({ name: 'Food' });
    await db
      .insert(merchantRules)
      .values({ pattern: 'mercadona', walletId: wallet.id, matchType: 'exact' });
    invalidateContainsCache();

    const res = await postWebhook({ text: 'Pagaste 12,50 € en Mercadona' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('classified');

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.walletId).toBe(wallet.id);
    expect(txs[0]?.amount).toBe(1250);
    expect(txs[0]?.status).toBe('classified');

    expect(sendConfirmation).toHaveBeenCalledTimes(1);
    expect(sendClassifyPrompt).toHaveBeenCalledTimes(0);
    expect(sendParseFailedPrompt).toHaveBeenCalledTimes(0);
  });

  test('pending path: no rule triggers classify prompt and stores msgId', async () => {
    await seedWallet({ name: 'Food' });
    const res = await postWebhook({ text: 'Pagaste 5,00 € en UnknownShop' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('pending');

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.status).toBe('pending');
    expect(txs[0]?.walletId).toBeNull();
    expect(txs[0]?.telegramMessageId).toBe(1001);

    expect(sendClassifyPrompt).toHaveBeenCalledTimes(1);
  });

  test('parse_failed path writes to parse_failures not transactions', async () => {
    const res = await postWebhook({ text: 'garbage text no match' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('parse_failed');

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(0);

    const pfs = await db.select().from(parseFailures);
    expect(pfs.length).toBe(1);
    expect(pfs[0]?.errorCode).toBe('no_match');
    expect(pfs[0]?.telegramMessageId).toBe(2002);

    expect(sendParseFailedPrompt).toHaveBeenCalledTimes(1);
  });

  test('telegram failure on pending does not crash webhook', async () => {
    sendClassifyPrompt.mockImplementationOnce(async () => {
      throw new Error('telegram down');
    });
    await seedWallet({ name: 'Food' });
    const res = await postWebhook({ text: 'Pagaste 3,00 € en SomeShop' });
    expect(res.status).toBe(200);

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.telegramMessageId).toBeNull();
  });
});
