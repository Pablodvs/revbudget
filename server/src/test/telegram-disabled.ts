// Child-process fixture for services/telegram-disabled.test.ts. Config and the
// Telegram client are built once at import, so the unconfigured path can only
// be exercised in a fresh process started with TELEGRAM_* blank.
import { app } from '../app';
import { db } from '../db';
import { transactions } from '../db/schema';
import {
  sendClassifyPrompt,
  sendConfirmRulePrompt,
  sendConfirmation,
  sendParseFailedPrompt,
  telegram,
} from '../services/telegram';
import { ensureMigrated } from './db';

ensureMigrated();
const tx = { id: 1, merchantDisplay: 'Shop', amount: 100, currency: 'EUR' };
const res = await app.request('/api/webhook/revolut', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Webhook-Secret': process.env.WEBHOOK_SECRET ?? '',
  },
  body: JSON.stringify({ text: 'You paid €12.50 at Corner Shop' }),
});
console.log(
  JSON.stringify({
    telegram,
    webhook: { status: res.status, body: await res.json() },
    stored: (await db.select().from(transactions)).map((t) => ({
      amount: t.amount,
      status: t.status,
    })),
    notifiers: [
      await sendClassifyPrompt(tx),
      await sendConfirmRulePrompt({ ...tx, walletName: 'Food', walletIcon: null }),
      await sendParseFailedPrompt({ id: 1, rawText: 'junk' }),
      (await sendConfirmation({ ...tx, walletName: 'Food', walletIcon: null })) ?? null,
    ],
  }),
);
// The webhook rate limiter's sweeper interval would keep the process alive.
process.exit(0);
