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

type NormalizerResult = {
  canonical: string;
  parsed: {
    type: 'expense' | 'income' | 'refund';
    amount: number;
    currency: string;
    merchant: string;
    merchantDisplay: string;
    transactionDate: string;
  };
};

const normalizeWithOllama = mock(
  async (_raw: string, _rid: string, _receivedAt: Date): Promise<NormalizerResult | null> => null,
);

mock.module('../services/ollama-normalizer', () => ({
  normalizeWithOllama,
}));

const { config: runtimeConfig } = await import('../config');
const originalOllamaEnabled = runtimeConfig.OLLAMA_ENABLED;

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
  normalizeWithOllama.mockClear();
  (runtimeConfig as { OLLAMA_ENABLED: boolean }).OLLAMA_ENABLED = originalOllamaEnabled;
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
      body: JSON.stringify({ text: 'You paid €12.00 at Mercadona' }),
    });
    expect(res.status).toBe(401);
  });

  test('rejects wrong secret with 401', async () => {
    const res = await postWebhook(
      { text: 'You paid €12.00 at Mercadona' },
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

    const res = await postWebhook({ text: 'You paid €12.50 at Mercadona' });
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
    const res = await postWebhook({ text: 'You paid €5.00 at UnknownShop' });
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

  test('ollama rescue: rewritten text parses and inserts transaction', async () => {
    (runtimeConfig as { OLLAMA_ENABLED: boolean }).OLLAMA_ENABLED = true;
    const { parseNotification } = await import('../services/notification-parser');
    normalizeWithOllama.mockImplementationOnce(async (_raw, _rid, receivedAt) => {
      const canonical = 'You paid €15.40 at MERCADONA';
      const validation = parseNotification(canonical, receivedAt);
      if (!validation.ok) throw new Error('mock canonical did not parse');
      return { canonical, parsed: validation.value };
    });

    const res = await postWebhook({ text: '💸 odd Revolut wording €15.40 MERCADONA' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('pending');

    expect(normalizeWithOllama).toHaveBeenCalledTimes(1);
    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.amount).toBe(1540);
    expect(txs[0]?.currency).toBe('EUR');
    expect(txs[0]?.rawText).toBe('💸 odd Revolut wording €15.40 MERCADONA');
    const pfs = await db.select().from(parseFailures);
    expect(pfs.length).toBe(0);
  });

  test('ollama rescue: null result falls back to parse_failed', async () => {
    (runtimeConfig as { OLLAMA_ENABLED: boolean }).OLLAMA_ENABLED = true;
    normalizeWithOllama.mockImplementationOnce(async () => null);

    const res = await postWebhook({ text: 'totally unrecognizable text' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('parse_failed');

    expect(normalizeWithOllama).toHaveBeenCalledTimes(1);
    const pfs = await db.select().from(parseFailures);
    expect(pfs.length).toBe(1);
    expect(sendParseFailedPrompt).toHaveBeenCalledTimes(1);
  });

  test('ollama disabled: no call to normalizer', async () => {
    (runtimeConfig as { OLLAMA_ENABLED: boolean }).OLLAMA_ENABLED = false;

    const res = await postWebhook({ text: 'garbage text no match' });
    expect(res.status).toBe(200);
    expect(normalizeWithOllama).toHaveBeenCalledTimes(0);
  });

  test('income notification inserts transaction with type=income', async () => {
    const res = await postWebhook({ text: 'You received €25.00 from Alice' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('pending');

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.type).toBe('income');
    expect(txs[0]?.amount).toBe(2500);
    expect(txs[0]?.currency).toBe('EUR');
    expect(txs[0]?.merchantDisplay).toBe('Alice');
  });

  test('refund notification inserts transaction with type=refund', async () => {
    const res = await postWebhook({ text: 'Refund of €3.00 from SPAR' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('pending');

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.type).toBe('refund');
    expect(txs[0]?.amount).toBe(300);
    expect(txs[0]?.merchantDisplay).toBe('SPAR');
  });

  test('income: classified path when sender has merchant rule', async () => {
    const wallet = await seedWallet({ name: 'Salary' });
    await db
      .insert(merchantRules)
      .values({ pattern: 'acme corp', walletId: wallet.id, matchType: 'exact' });
    invalidateContainsCache();

    const res = await postWebhook({ text: 'You received €1,500.00 from ACME Corp' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('classified');

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.type).toBe('income');
    expect(txs[0]?.walletId).toBe(wallet.id);
    expect(txs[0]?.amount).toBe(150000);
  });

  test('telegram failure on pending does not crash webhook', async () => {
    sendClassifyPrompt.mockImplementationOnce(async () => {
      throw new Error('telegram down');
    });
    await seedWallet({ name: 'Food' });
    const res = await postWebhook({ text: 'You paid €3.00 at SomeShop' });
    expect(res.status).toBe(200);

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.telegramMessageId).toBeNull();
  });
});
