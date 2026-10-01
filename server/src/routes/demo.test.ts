import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { count, eq } from 'drizzle-orm';
import { app } from '../app';
import { config } from '../config';
import { db } from '../db';
import { merchantRules, parseFailures, transactions, wallets } from '../db/schema';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { invalidateContainsCache } from '../services/classifier';
import { DEMO_CAPS } from '../services/demo';
import * as telegram from '../services/telegram';
import { authedHeaders, ensureMigrated, seedWallet, truncateAll, truncateAuth } from '../test/db';

// A demo never has Telegram (config refuses it), but this suite's config has
// the preload's fake bot: keep it unreached.
spyOn(telegram, 'sendClassifyPrompt').mockResolvedValue(null);
spyOn(telegram, 'sendConfirmRulePrompt').mockResolvedValue(null);
spyOn(telegram, 'sendParseFailedPrompt').mockResolvedValue(null);
spyOn(telegram, 'sendConfirmation').mockResolvedValue(undefined);

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
  mock.restore();
});

beforeEach(async () => {
  await truncateAll();
  await truncateAuth();
  invalidateContainsCache();
  config.DEMO_MODE = true;
});

afterEach(() => {
  config.DEMO_MODE = false;
});

// A fresh client address per test: the route's limiter keys on it.
let client = 0;
async function postNotification(body: unknown, headers?: Record<string, string>) {
  return app.request('/api/demo/notifications', {
    method: 'POST',
    headers: headers ?? {
      ...(await authedHeaders()),
      'cf-connecting-ip': `192.0.2.${++client}`,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/demo/notifications', () => {
  test('ingests the text like the webhook and returns the new transaction', async () => {
    const res = await postNotification({ text: 'You paid €4.20 at Blue Bottle Coffee' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; transactionId: number };
    expect(body).toEqual({ ok: true, status: 'pending', transactionId: expect.any(Number) });

    const [stored] = await db.select().from(transactions);
    expect(stored?.id).toBe(body.transactionId);
    expect(stored?.amount).toBe(420);
    expect(stored?.merchantDisplay).toBe('Blue Bottle Coffee');
  });

  test('an unparseable text is a parse failure, with no transaction', async () => {
    const res = await postNotification({ text: 'Your card ending 4821 was used online' });
    expect(await res.json()).toEqual({ ok: true, status: 'parse_failed', transactionId: null });
  });

  test('outside demo mode it is an unknown path, even signed in', async () => {
    config.DEMO_MODE = false;
    // Indistinguishable from a path that doesn't exist: same status, content
    // type and body (bar the per-request id), so a probe can't find the route.
    const shape = async (res: Response) => {
      const { requestId, ...body } = (await res.json()) as { requestId: string };
      return {
        status: res.status,
        type: res.headers.get('content-type'),
        body,
        id: typeof requestId,
      };
    };
    for (const headers of [{ 'Content-Type': 'application/json' }, await authedHeaders()]) {
      const demo = await postNotification({ text: 'You paid €1.00 at Tesco' }, headers);
      const unknown = await app.request('/api/demo/nope', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'You paid €1.00 at Tesco' }),
      });
      const demoShape = await shape(demo);
      expect(demoShape).toEqual(await shape(unknown));
      expect(demoShape.body).toEqual({ error: 'not_found' });
    }
    expect(await db.select().from(transactions)).toEqual([]);
  });

  test('requires a session', async () => {
    const res = await postNotification(
      { text: 'You paid €1.00 at Tesco' },
      { 'Content-Type': 'application/json' },
    );
    expect(res.status).toBe(401);
  });

  test.each([
    ['empty', ''],
    ['over 500 chars', `You paid €1.00 at ${'x'.repeat(490)}`],
    ['missing', undefined],
  ])('rejects a text that is %s', async (_name, text) => {
    const res = await postNotification({ text });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe('validation_failed');
    expect(body.issues[0]?.path).toBe('text');
  });

  test('rate limits a client after 20 quick notifications', async () => {
    const headers = { ...(await authedHeaders()), 'cf-connecting-ip': '198.51.100.7' };
    for (let i = 0; i < 20; i++) {
      expect((await postNotification({ text: 'x' }, headers)).status).toBe(200);
    }
    const res = await postNotification({ text: 'x' }, headers);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('rate_limited');
  });
});

// A signed-in API call from a fresh client address, clear of the write rate limit.
async function call(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...(await authedHeaders()), 'cf-connecting-ip': `192.0.2.${++client}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('demo write rate limit', () => {
  const writes = [
    ['DELETE', '/api/wallets/999999'],
    ['PUT', '/api/transactions/999999'],
    ['DELETE', '/api/merchant-rules/999999'],
  ] as const;
  const write = (i: number, headers: Record<string, string>) => {
    const [method, path] = writes[i % writes.length] ?? writes[0];
    return app.request(path, { method, headers, body: method === 'PUT' ? '{}' : undefined });
  };

  test('holds a visitor to 30 quick writes across the API, but not their reads', async () => {
    const headers = { ...(await authedHeaders()), 'cf-connecting-ip': '198.51.100.8' };
    for (let i = 0; i < 30; i++) expect((await write(i, headers)).status).toBe(404);
    const res = await app.request('/api/wallets', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Trips', budget: 10000, color: '#22c55e' }),
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('rate_limited');
    expect((await app.request('/api/wallets', { headers })).status).toBe(200);
  });

  test('is off outside demo mode', async () => {
    config.DEMO_MODE = false;
    const headers = { ...(await authedHeaders()), 'cf-connecting-ip': '198.51.100.9' };
    for (let i = 0; i < 40; i++) expect((await write(i, headers)).status).toBe(404);
  });
});

describe('demo row caps', () => {
  const unreadable = 'Your card ending 4821 was used online';
  const newMerchant = 'You paid €4.20 at Blue Bottle Coffee';
  let walletId: number;

  beforeEach(async () => {
    walletId = (await seedWallet()).id;
  });

  const tables = { transactions, parseFailures, wallets, merchantRules };

  // Tops a table up to `total` rows, straight into the database (the API would
  // rate limit first).
  function fill(table: keyof typeof DEMO_CAPS, total: number) {
    db.transaction((t) => {
      const have = t.select({ n: count() }).from(tables[table]).get()?.n ?? 0;
      for (let i = have; i < total; i++) {
        if (table === 'transactions') {
          t.insert(transactions)
            .values({
              walletId,
              amount: 100,
              merchant: 'flood',
              merchantDisplay: 'Flood',
              rawText: 'x',
              status: 'classified',
              transactionDate: new Date().toISOString(),
            })
            .run();
        } else if (table === 'parseFailures') {
          t.insert(parseFailures)
            .values({ rawText: 'x', errorCode: 'no_match', receivedAt: new Date().toISOString() })
            .run();
        } else if (table === 'wallets') {
          t.insert(wallets)
            .values({ name: `W${i}`, budget: 100, color: '#22c55e' })
            .run();
        } else {
          t.insert(merchantRules)
            .values({ pattern: `rule ${i}`, walletId })
            .run();
        }
      }
    });
  }

  async function expectDemoFull(res: Response) {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'demo_full', requestId: expect.any(String) });
  }

  const newTransaction = () => ({
    walletId,
    amount: 500,
    type: 'expense',
    merchantDisplay: 'Corner Shop',
    transactionDate: new Date().toISOString(),
  });
  const newWallet = { name: 'Trips', budget: 10000, color: '#22c55e' };
  let rules = 0;
  const newRule = () => ({ pattern: `Shop ${++rules}`, walletId, matchType: 'exact' });

  test('transactions stop at the cap, from the API or a notification', async () => {
    fill('transactions', DEMO_CAPS.transactions - 1);
    expect((await call('POST', '/api/transactions', newTransaction())).status).toBe(201);
    await expectDemoFull(await call('POST', '/api/transactions', newTransaction()));
    await expectDemoFull(await postNotification({ text: newMerchant }));
    // A parse failure isn't a transaction.
    expect((await postNotification({ text: unreadable })).status).toBe(200);
    expect((await db.select().from(transactions)).length).toBe(DEMO_CAPS.transactions);
  });

  test('parse failures stop at the cap', async () => {
    fill('parseFailures', DEMO_CAPS.parseFailures - 1);
    expect((await postNotification({ text: unreadable })).status).toBe(200);
    await expectDemoFull(await postNotification({ text: unreadable }));
    expect((await postNotification({ text: newMerchant })).status).toBe(200);
    expect((await db.select().from(parseFailures)).length).toBe(DEMO_CAPS.parseFailures);
  });

  test('wallets stop at the cap', async () => {
    fill('wallets', DEMO_CAPS.wallets - 1);
    expect((await call('POST', '/api/wallets', newWallet)).status).toBe(201);
    await expectDemoFull(await call('POST', '/api/wallets', newWallet));
    expect((await db.select().from(wallets)).length).toBe(DEMO_CAPS.wallets);
  });

  test('rules stop at the cap, and a full demo classifies without learning one', async () => {
    fill('merchantRules', DEMO_CAPS.merchantRules - 1);
    expect((await call('POST', '/api/merchant-rules', newRule())).status).toBe(201);
    await expectDemoFull(await call('POST', '/api/merchant-rules', newRule()));

    const { transactionId } = (await (await postNotification({ text: newMerchant })).json()) as {
      transactionId: number;
    };
    const res = await call('PUT', `/api/transactions/${transactionId}`, { walletId });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('classified');
    expect((await db.select().from(merchantRules)).length).toBe(DEMO_CAPS.merchantRules);
  });

  test('are off outside demo mode', async () => {
    config.DEMO_MODE = false;
    for (const table of Object.keys(DEMO_CAPS) as (keyof typeof DEMO_CAPS)[]) {
      fill(table, DEMO_CAPS[table]);
    }
    const webhook = (text: string) =>
      app.request('/api/webhook/revolut', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': config.WEBHOOK_SECRET,
          'cf-connecting-ip': `192.0.2.${++client}`,
        },
        body: JSON.stringify({ text }),
      });
    expect((await call('POST', '/api/transactions', newTransaction())).status).toBe(201);
    expect((await call('POST', '/api/wallets', newWallet)).status).toBe(201);
    expect((await call('POST', '/api/merchant-rules', newRule())).status).toBe(201);
    expect(await (await webhook(unreadable)).json()).toEqual({ ok: true, status: 'parse_failed' });
    expect(await (await webhook(newMerchant)).json()).toEqual({ ok: true, status: 'pending' });

    const [pending] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.status, 'pending'));
    expect((await call('PUT', `/api/transactions/${pending?.id}`, { walletId })).status).toBe(200);
    expect((await db.select().from(merchantRules)).length).toBe(DEMO_CAPS.merchantRules + 2);
  });
});
