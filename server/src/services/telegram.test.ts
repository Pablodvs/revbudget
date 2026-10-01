import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import { db } from '../db';
import { merchantRules, transactions } from '../db/schema';
import { ensureMigrated, seedWallet, truncateAll } from '../test/db';
import { invalidateContainsCache } from './classifier';
import { telegram } from './telegram';

// Drives the real handlers with fake updates. Every Bot API call they make is
// recorded and answered here, never sent.
if (!telegram) throw new Error('the test preload configures Telegram');
const { bot, chatId } = telegram;
const calls: { method: string; text?: string }[] = [];
let intercepting = true;
bot.api.config.use((prev, method, payload, signal) => {
  if (!intercepting) return prev(method, payload, signal);
  calls.push({ method, text: (payload as { text?: string }).text });
  return Promise.resolve({ ok: true, result: true } as never);
});
// Skips the getMe call handleUpdate would otherwise make.
bot.botInfo = {
  id: 1,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
} as typeof bot.botInfo;

let updateId = 0;

// A button press on a bot message in `chat`, or on an inline message (no chat).
function press(data: string, chat: number | null = chatId) {
  updateId += 1;
  return bot.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      chat_instance: 'test',
      from: { id: chat ?? 1, is_bot: false, first_name: 'User' },
      data,
      ...(chat === null
        ? { inline_message_id: 'inline' }
        : {
            message: {
              message_id: 1,
              date: 0,
              chat: { id: chat, type: 'private', first_name: 'User' },
              text: 'prompt',
            },
          }),
    },
  } as Update);
}

// A bot command sent in `chat`.
function send(text: string, chat: number) {
  updateId += 1;
  return bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chat, type: 'private', first_name: 'User' },
      from: { id: chat, is_bot: false, first_name: 'User' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  } as Update);
}

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  intercepting = false;
});

beforeEach(async () => {
  await truncateAll();
  invalidateContainsCache();
  calls.length = 0;
});

async function txRow(id: number) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
  return row;
}

const lastEdit = () => calls.filter((c) => c.method === 'editMessageText').at(-1)?.text;

async function addTx(walletId: number | null, status: 'pending' | 'pending_confirmation') {
  const [row] = await db
    .insert(transactions)
    .values({
      walletId,
      amount: 1540,
      merchant: 'mercadona',
      merchantDisplay: 'MERCADONA',
      rawText: 'odd wording',
      status,
      type: 'expense',
      transactionDate: '2026-03-10T12:00:00.000Z',
    })
    .returning();
  if (!row) throw new Error('addTx: no row returned');
  return row;
}

// What webhook.ts stores for an LLM-rescued notification whose merchant has an
// auto-classify rule: the rule's wallet, waiting for a confirmation anyway.
const rescuedTx = (walletId: number) => addTx(walletId, 'pending_confirmation');

async function autoRule(walletId: number) {
  await db.insert(merchantRules).values({
    pattern: 'mercadona',
    walletId,
    matchType: 'exact',
    requireConfirmation: false,
  });
}

describe('Undo on a confirmed rule suggestion', () => {
  test('returns an LLM-rescued transaction to its confirm prompt', async () => {
    const food = await seedWallet({ name: 'Food' });
    await autoRule(food.id);
    const tx = await rescuedTx(food.id);

    await press(`confirm_rule:${tx.id}`);
    expect(await txRow(tx.id)).toMatchObject({ status: 'classified', walletId: food.id });

    await press(`undo_confirm:${tx.id}`);
    expect(await txRow(tx.id)).toMatchObject({
      status: 'pending_confirmation',
      walletId: food.id,
      classifiedAt: null,
    });
    expect(lastEdit()).toContain('Rule suggests: 🍕 Food');
  });

  test('after "Choose other", returns to the prompt, not to the rejected wallet', async () => {
    const food = await seedWallet({ name: 'Food' });
    const home = await seedWallet({ name: 'Home' });
    await autoRule(food.id);
    const tx = await rescuedTx(food.id);

    await press(`choose_other:${tx.id}`);
    await press(`reassign:${tx.id}:${home.id}`);
    expect(await txRow(tx.id)).toMatchObject({ status: 'classified', walletId: home.id });

    await press(`undo_confirm:${tx.id}`);
    expect(await txRow(tx.id)).toMatchObject({
      status: 'pending_confirmation',
      walletId: food.id,
      classifiedAt: null,
    });
    expect(lastEdit()).toContain('Confirm or choose another wallet');
  });

  test('goes back to pending when no rule matches any more', async () => {
    const food = await seedWallet({ name: 'Food' });
    await autoRule(food.id);
    const tx = await rescuedTx(food.id);
    await press(`confirm_rule:${tx.id}`);
    await db.delete(merchantRules);

    await press(`undo_confirm:${tx.id}`);
    expect(await txRow(tx.id)).toMatchObject({
      status: 'pending',
      walletId: null,
      classifiedAt: null,
    });
    expect(lastEdit()).toContain('Classify:');
  });
});

describe('Undo on a manual classification', () => {
  test('forgets the rule that classification learned, but not an older one', async () => {
    const food = await seedWallet({ name: 'Food' });
    const first = await addTx(null, 'pending');
    await press(`classify:${first.id}:${food.id}`);
    expect(await db.select().from(merchantRules)).toHaveLength(1);
    await press(`undo:${first.id}`);
    expect(await db.select().from(merchantRules)).toHaveLength(0);
    expect(await txRow(first.id)).toMatchObject({ status: 'pending', walletId: null });

    // Written by the user after the prompt went out.
    await db
      .insert(merchantRules)
      .values({ pattern: 'mercadona', walletId: food.id, matchType: 'exact' });
    await press(`classify:${first.id}:${food.id}`);
    await press(`undo:${first.id}`);
    expect(await db.select().from(merchantRules)).toMatchObject([
      { pattern: 'mercadona', walletId: food.id, requireConfirmation: true },
    ]);
    expect(lastEdit()).toContain('Classify:');
  });
});

describe('chat allowlist', () => {
  const OTHER_CHAT = 555;

  test('ignores commands from another chat', async () => {
    await send('/status', OTHER_CHAT);
    await send('/wallets', OTHER_CHAT);
    expect(calls).toEqual([]);

    await send('/wallets', chatId);
    expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
  });

  test('turns away a button press from another chat, or from no chat', async () => {
    const tx = await addTx(null, 'pending');
    await press(`ignore:${tx.id}`, OTHER_CHAT);
    await press(`ignore:${tx.id}`, null);
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', text: 'Not authorized' },
      { method: 'answerCallbackQuery', text: 'Not authorized' },
    ]);
    expect(await txRow(tx.id)).toMatchObject({ status: 'pending' });

    await press(`ignore:${tx.id}`);
    expect(await txRow(tx.id)).toMatchObject({ status: 'ignored' });
  });
});
