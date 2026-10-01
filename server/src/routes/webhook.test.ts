import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { app } from '../app';
import { config as runtimeConfig } from '../config';
import { db } from '../db';
import { merchantRules, parseFailures, transactions } from '../db/schema';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { invalidateContainsCache } from '../services/classifier';
import * as normalizer from '../services/ollama-normalizer';
import * as telegram from '../services/telegram';
import { ensureMigrated, seedWallet, truncateAll } from '../test/db';

// spyOn swaps the exports webhook.ts calls and mock.restore() in afterAll puts
// them back: unlike mock.module, nothing leaks into the other test files.
const sendClassifyPrompt = spyOn(telegram, 'sendClassifyPrompt').mockImplementation(
  async () => 1001,
);
const sendConfirmation = spyOn(telegram, 'sendConfirmation').mockImplementation(
  async () => undefined,
);
const sendConfirmRulePrompt = spyOn(telegram, 'sendConfirmRulePrompt').mockImplementation(
  async () => 3003,
);
const sendParseFailedPrompt = spyOn(telegram, 'sendParseFailedPrompt').mockImplementation(
  async () => 2002,
);
const normalizeWithOllama = spyOn(normalizer, 'normalizeWithOllama').mockImplementation(
  async () => null,
);

const originalOllamaEnabled = runtimeConfig.OLLAMA_ENABLED;

const WEBHOOK_SECRET = 'test_secret_must_be_at_least_32_chars_long';

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
  mock.restore();
  (runtimeConfig as { OLLAMA_ENABLED: boolean }).OLLAMA_ENABLED = originalOllamaEnabled;
});

beforeEach(async () => {
  await truncateAll();
  invalidateContainsCache();
  sendClassifyPrompt.mockClear();
  sendConfirmation.mockClear();
  sendConfirmRulePrompt.mockClear();
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

  test('rate limits a whole IPv6 /64 as one client', async () => {
    const hitFrom = (i: number) =>
      app.request('/api/webhook/revolut', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': 'wrong_secret_padded_to_over_32_chars_xxxx',
          'cf-connecting-ip': `2001:db8:64:64::${i.toString(16)}`,
        },
        body: JSON.stringify({ text: 'x' }),
      });
    for (let i = 1; i <= 60; i++) {
      expect((await hitFrom(i)).status).toBe(401);
    }
    expect((await hitFrom(61)).status).toBe(429);
  });

  test('auto-classify when rule.requireConfirmation=false', async () => {
    const wallet = await seedWallet({ name: 'Food' });
    await db.insert(merchantRules).values({
      pattern: 'mercadona',
      walletId: wallet.id,
      matchType: 'exact',
      requireConfirmation: false,
    });
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
    expect(sendConfirmRulePrompt).toHaveBeenCalledTimes(0);
    expect(sendParseFailedPrompt).toHaveBeenCalledTimes(0);
  });

  test('pending_confirmation when rule.requireConfirmation=true', async () => {
    const wallet = await seedWallet({ name: 'Food' });
    await db
      .insert(merchantRules)
      .values({ pattern: 'mercadona', walletId: wallet.id, matchType: 'exact' });
    invalidateContainsCache();

    const res = await postWebhook({ text: 'You paid €8.00 at Mercadona' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('pending_confirmation');

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.walletId).toBe(wallet.id);
    expect(txs[0]?.status).toBe('pending_confirmation');
    expect(txs[0]?.classifiedAt).toBeNull();
    expect(txs[0]?.telegramMessageId).toBe(3003);

    expect(sendConfirmRulePrompt).toHaveBeenCalledTimes(1);
    expect(sendConfirmation).toHaveBeenCalledTimes(0);
    expect(sendClassifyPrompt).toHaveBeenCalledTimes(0);
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

  test('ollama rescue: a matching auto-classify rule still asks for confirmation', async () => {
    (runtimeConfig as { OLLAMA_ENABLED: boolean }).OLLAMA_ENABLED = true;
    const wallet = await seedWallet({ name: 'Food' });
    await db.insert(merchantRules).values({
      pattern: 'mercadona',
      walletId: wallet.id,
      matchType: 'exact',
      requireConfirmation: false,
    });
    invalidateContainsCache();
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
    expect(body.status).toBe('pending_confirmation');

    const txs = await db.select().from(transactions);
    expect(txs.length).toBe(1);
    expect(txs[0]?.status).toBe('pending_confirmation');
    expect(txs[0]?.walletId).toBe(wallet.id);
    expect(txs[0]?.classifiedAt).toBeNull();
    expect(sendConfirmRulePrompt).toHaveBeenCalledTimes(1);
    expect(sendConfirmation).toHaveBeenCalledTimes(0);
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

  test('income: auto-classify when rule.requireConfirmation=false', async () => {
    const wallet = await seedWallet({ name: 'Salary' });
    await db.insert(merchantRules).values({
      pattern: 'acme corp',
      walletId: wallet.id,
      matchType: 'exact',
      requireConfirmation: false,
    });
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
