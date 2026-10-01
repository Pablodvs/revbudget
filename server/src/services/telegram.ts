import { and, eq, ne } from 'drizzle-orm';
import { Bot, Composer, InlineKeyboard } from 'grammy';
import { currentMonth, formatCents } from 'shared';
import { config } from '../config';
import { db } from '../db';
import { parseFailures, transactions, wallets } from '../db/schema';
import { log } from '../lib/log';
import { classifyMerchant, classifyTransaction, unclassifyTransaction } from './classifier';
import { formatMonthlySummary, monthlySummary } from './stats';

// Handlers live on a Composer so they can be registered without a token. The
// Bot only exists when Telegram is configured; otherwise every notifier below
// no-ops (webhooks still store transactions) and index.ts never starts polling.
const handlers = new Composer();

export const telegram = config.telegram && {
  bot: new Bot(config.telegram.botToken),
  chatId: config.telegram.chatId,
};
telegram?.bot.use(handlers);

handlers.use(async (ctx, next) => {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (chatId === undefined || chatId !== telegram?.chatId) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: false }).catch(() => {});
    }
    return;
  }
  await next();
});

async function buildClassifyKeyboard(transactionId: number): Promise<InlineKeyboard> {
  const active = await db
    .select({
      id: wallets.id,
      name: wallets.name,
      icon: wallets.icon,
    })
    .from(wallets)
    .where(eq(wallets.isActive, true));
  const kb = new InlineKeyboard();
  active.forEach((w, i) => {
    const label = `${w.icon ?? ''} ${w.name}`.trim();
    kb.text(label, `classify:${transactionId}:${w.id}`);
    if (i % 2 === 1) kb.row();
  });
  if (active.length % 2 === 1) kb.row();
  kb.text('🚫 Ignore', `ignore:${transactionId}`);
  return kb;
}

function buildConfirmRuleKeyboard(transactionId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Confirm', `confirm_rule:${transactionId}`)
    .row()
    .text('🔁 Choose other', `choose_other:${transactionId}`)
    .row()
    .text('🚫 Ignore', `ignore:${transactionId}`);
}

async function buildReassignKeyboard(
  transactionId: number,
  currentWalletId: number,
): Promise<InlineKeyboard> {
  const active = await db
    .select({
      id: wallets.id,
      name: wallets.name,
      icon: wallets.icon,
    })
    .from(wallets)
    .where(and(eq(wallets.isActive, true), ne(wallets.id, currentWalletId)))
    .orderBy(wallets.id);
  const kb = new InlineKeyboard();
  active.forEach((w, i) => {
    const label = `${w.icon ?? ''} ${w.name}`.trim();
    kb.text(label, `reassign:${transactionId}:${w.id}`);
    if (i % 2 === 1) kb.row();
  });
  if (active.length % 2 === 1) kb.row();
  kb.text('↩️ Back', `confirm_back:${transactionId}`).text('🚫 Ignore', `ignore:${transactionId}`);
  return kb;
}

type AnswerableCtx = {
  answerCallbackQuery: (opts?: { text?: string }) => Promise<unknown>;
};

async function loadConfirmableTx(
  ctx: AnswerableCtx,
  txId: number,
): Promise<{
  tx: typeof transactions.$inferSelect;
  wallet: typeof wallets.$inferSelect;
} | null> {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, txId)).limit(1);
  if (!tx) {
    await ctx.answerCallbackQuery({ text: 'Transaction not found' });
    return null;
  }
  if (tx.status !== 'pending_confirmation' || tx.walletId === null) {
    await ctx.answerCallbackQuery({ text: 'Already resolved' });
    return null;
  }
  const [wallet] = await db.select().from(wallets).where(eq(wallets.id, tx.walletId)).limit(1);
  if (!wallet) {
    await ctx.answerCallbackQuery({ text: 'Wallet not found' });
    return null;
  }
  return { tx, wallet };
}

function confirmRulePromptText(tx: {
  merchantDisplay: string;
  amount: number;
  currency: string;
  walletName: string;
  walletIcon: string | null;
}): string {
  const walletLabel = `${tx.walletIcon ?? ''} ${tx.walletName}`.trim();
  return `💳 ${tx.merchantDisplay}\n${formatCents(tx.amount, tx.currency)}\n\n🎯 Rule suggests: ${walletLabel}\n\nConfirm or choose another wallet:`;
}

function reassignPromptText(tx: {
  merchantDisplay: string;
  amount: number;
  currency: string;
}): string {
  return `💳 ${tx.merchantDisplay}\n${formatCents(tx.amount, tx.currency)}\n\nPick a wallet:`;
}

export async function sendClassifyPrompt(tx: {
  id: number;
  merchantDisplay: string;
  amount: number;
  currency: string;
}): Promise<number | null> {
  if (!telegram) return null;
  const kb = await buildClassifyKeyboard(tx.id);
  const msg = await telegram.bot.api.sendMessage(
    telegram.chatId,
    `💳 ${tx.merchantDisplay}\n${formatCents(tx.amount, tx.currency)}\n\nClassify:`,
    { reply_markup: kb },
  );
  return msg.message_id ?? null;
}

export async function sendConfirmation(tx: {
  merchantDisplay: string;
  amount: number;
  currency: string;
  walletName: string;
  walletIcon: string | null;
}): Promise<void> {
  if (!telegram) return;
  await telegram.bot.api.sendMessage(
    telegram.chatId,
    `✅ ${tx.merchantDisplay} ${formatCents(tx.amount, tx.currency)} → ${tx.walletName} ${tx.walletIcon ?? ''}`.trim(),
  );
}

export async function sendConfirmRulePrompt(tx: {
  id: number;
  merchantDisplay: string;
  amount: number;
  currency: string;
  walletName: string;
  walletIcon: string | null;
}): Promise<number | null> {
  if (!telegram) return null;
  const msg = await telegram.bot.api.sendMessage(telegram.chatId, confirmRulePromptText(tx), {
    reply_markup: buildConfirmRuleKeyboard(tx.id),
  });
  return msg.message_id ?? null;
}

export async function sendParseFailedPrompt(pf: {
  id: number;
  rawText: string;
}): Promise<number | null> {
  if (!telegram) return null;
  const snippet = pf.rawText
    .slice(0, 500)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  const kb = new InlineKeyboard().text('🗑 Dismiss', `pf_dismiss:${pf.id}`);
  const msg = await telegram.bot.api.sendMessage(
    telegram.chatId,
    `⚠️ Could not parse notification:\n${snippet}`,
    { reply_markup: kb },
  );
  return msg.message_id ?? null;
}

handlers.command('start', async (ctx) => {
  await ctx.reply('👋 RevBudget bot ready. Use /status or /wallets.');
});

handlers.command('status', async (ctx) => {
  const summary = await monthlySummary(currentMonth(new Date(), config.APP_TIMEZONE));
  await ctx.reply(formatMonthlySummary(summary));
});

handlers.command('wallets', async (ctx) => {
  const walletRows = await db.select().from(wallets).where(eq(wallets.isActive, true));
  const lines = walletRows.map(
    (w) => `${w.icon ?? ''} ${w.name} — budget ${formatCents(w.budget, w.currency)}`,
  );
  await ctx.reply(lines.join('\n') || 'No active wallets');
});

handlers.callbackQuery(/^classify:(\d+):(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;
  const txId = Number(match[1]);
  const walletId = Number(match[2]);
  try {
    const txRows = await db.select().from(transactions).where(eq(transactions.id, txId)).limit(1);
    const tx = txRows[0];
    if (!tx) {
      await ctx.answerCallbackQuery({ text: 'Transaction not found' });
      return;
    }
    const wRows = await db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1);
    const wallet = wRows[0];
    if (!wallet) {
      await ctx.answerCallbackQuery({ text: 'Wallet not found' });
      return;
    }
    classifyTransaction(tx, walletId);
    const text =
      `✅ ${tx.merchantDisplay} ${formatCents(tx.amount, tx.currency)} → ${wallet.name} ${wallet.icon ?? ''}`.trim();
    const undoKb = new InlineKeyboard().text('↩️ Undo', `undo:${txId}`);
    await ctx.editMessageText(text, { reply_markup: undoKb });
    await ctx.answerCallbackQuery({ text: 'Classified' });
  } catch (err) {
    const rid = crypto.randomUUID();
    log.error(rid, 'telegram_classify_failed', { txId, walletId, err: String(err) });
    await ctx.answerCallbackQuery({ text: `Error (${rid.slice(0, 8)})` }).catch(() => {});
  }
});

handlers.callbackQuery(/^ignore:(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;
  const txId = Number(match[1]);
  try {
    const txRows = await db.select().from(transactions).where(eq(transactions.id, txId)).limit(1);
    const tx = txRows[0];
    if (!tx) {
      await ctx.answerCallbackQuery({ text: 'Transaction not found' });
      return;
    }
    const now = new Date().toISOString();
    await db
      .update(transactions)
      .set({ status: 'ignored', updatedAt: now })
      .where(eq(transactions.id, txId));
    await ctx.editMessageText(`🚫 Ignored: ${tx.merchantDisplay}`);
    await ctx.answerCallbackQuery({ text: 'Ignored' });
  } catch {
    await ctx.answerCallbackQuery({ text: 'Error' }).catch(() => {});
  }
});

handlers.callbackQuery(/^undo:(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;
  const txId = Number(match[1]);
  try {
    const txRows = await db.select().from(transactions).where(eq(transactions.id, txId)).limit(1);
    const tx = txRows[0];
    if (!tx) {
      await ctx.answerCallbackQuery({ text: 'Transaction not found' });
      return;
    }
    unclassifyTransaction(tx);
    const kb = await buildClassifyKeyboard(txId);
    await ctx.editMessageText(
      `💳 ${tx.merchantDisplay}\n${formatCents(tx.amount, tx.currency)}\n\nClassify:`,
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery({ text: 'Undone' });
  } catch {
    await ctx.answerCallbackQuery({ text: 'Error' }).catch(() => {});
  }
});

handlers.callbackQuery(/^confirm_rule:(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;
  const txId = Number(match[1]);
  try {
    const loaded = await loadConfirmableTx(ctx, txId);
    if (!loaded) return;
    const { tx, wallet } = loaded;
    const now = new Date().toISOString();
    await db
      .update(transactions)
      .set({ status: 'classified', classifiedAt: now, updatedAt: now })
      .where(eq(transactions.id, txId));
    const text =
      `✅ ${tx.merchantDisplay} ${formatCents(tx.amount, tx.currency)} → ${wallet.name} ${wallet.icon ?? ''}`.trim();
    const undoKb = new InlineKeyboard().text('↩️ Undo', `undo_confirm:${txId}`);
    await ctx.editMessageText(text, { reply_markup: undoKb });
    await ctx.answerCallbackQuery({ text: 'Confirmed' });
  } catch (err) {
    const rid = crypto.randomUUID();
    log.error(rid, 'telegram_confirm_rule_failed', { txId, err: String(err) });
    await ctx.answerCallbackQuery({ text: `Error (${rid.slice(0, 8)})` }).catch(() => {});
  }
});

handlers.callbackQuery(/^choose_other:(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;
  const txId = Number(match[1]);
  try {
    const loaded = await loadConfirmableTx(ctx, txId);
    if (!loaded) return;
    const { tx, wallet } = loaded;
    const kb = await buildReassignKeyboard(txId, wallet.id);
    await ctx.editMessageText(reassignPromptText(tx), { reply_markup: kb });
    await ctx.answerCallbackQuery();
  } catch (err) {
    const rid = crypto.randomUUID();
    log.error(rid, 'telegram_choose_other_failed', { txId, err: String(err) });
    await ctx.answerCallbackQuery({ text: `Error (${rid.slice(0, 8)})` }).catch(() => {});
  }
});

handlers.callbackQuery(/^confirm_back:(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;
  const txId = Number(match[1]);
  try {
    const loaded = await loadConfirmableTx(ctx, txId);
    if (!loaded) return;
    const { tx, wallet } = loaded;
    await ctx.editMessageText(
      confirmRulePromptText({
        merchantDisplay: tx.merchantDisplay,
        amount: tx.amount,
        currency: tx.currency,
        walletName: wallet.name,
        walletIcon: wallet.icon,
      }),
      { reply_markup: buildConfirmRuleKeyboard(txId) },
    );
    await ctx.answerCallbackQuery();
  } catch (err) {
    const rid = crypto.randomUUID();
    log.error(rid, 'telegram_confirm_back_failed', { txId, err: String(err) });
    await ctx.answerCallbackQuery({ text: `Error (${rid.slice(0, 8)})` }).catch(() => {});
  }
});

handlers.callbackQuery(/^reassign:(\d+):(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;
  const txId = Number(match[1]);
  const walletId = Number(match[2]);
  try {
    const loaded = await loadConfirmableTx(ctx, txId);
    if (!loaded) return;
    const { tx } = loaded;
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1);
    if (!wallet) {
      await ctx.answerCallbackQuery({ text: 'Wallet not found' });
      return;
    }
    const now = new Date().toISOString();
    await db
      .update(transactions)
      .set({ walletId, status: 'classified', classifiedAt: now, updatedAt: now })
      .where(eq(transactions.id, txId));
    const text =
      `✅ ${tx.merchantDisplay} ${formatCents(tx.amount, tx.currency)} → ${wallet.name} ${wallet.icon ?? ''}`.trim();
    const undoKb = new InlineKeyboard().text('↩️ Undo', `undo_confirm:${txId}`);
    await ctx.editMessageText(text, { reply_markup: undoKb });
    await ctx.answerCallbackQuery({ text: 'Reassigned' });
  } catch (err) {
    const rid = crypto.randomUUID();
    log.error(rid, 'telegram_reassign_failed', { txId, walletId, err: String(err) });
    await ctx.answerCallbackQuery({ text: `Error (${rid.slice(0, 8)})` }).catch(() => {});
  }
});

handlers.callbackQuery(/^undo_confirm:(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;
  const txId = Number(match[1]);
  try {
    const [tx] = await db.select().from(transactions).where(eq(transactions.id, txId)).limit(1);
    if (!tx) {
      await ctx.answerCallbackQuery({ text: 'Transaction not found' });
      return;
    }
    const result = await classifyMerchant(tx.merchant);
    const now = new Date().toISOString();
    // Back to the confirm prompt this message started as, even when the rule
    // itself would auto-classify: an LLM-rescued transaction's forced
    // confirmation isn't stored, and after "Choose other" the rule's wallet is
    // the one the user just turned down.
    if (result.walletId !== null && result.wallet !== null) {
      await db
        .update(transactions)
        .set({
          walletId: result.walletId,
          status: 'pending_confirmation',
          classifiedAt: null,
          updatedAt: now,
        })
        .where(eq(transactions.id, txId));
      await ctx.editMessageText(
        confirmRulePromptText({
          merchantDisplay: tx.merchantDisplay,
          amount: tx.amount,
          currency: tx.currency,
          walletName: result.wallet.name,
          walletIcon: result.wallet.icon,
        }),
        { reply_markup: buildConfirmRuleKeyboard(txId) },
      );
    } else {
      await db
        .update(transactions)
        .set({ walletId: null, status: 'pending', classifiedAt: null, updatedAt: now })
        .where(eq(transactions.id, txId));
      const kb = await buildClassifyKeyboard(txId);
      await ctx.editMessageText(
        `💳 ${tx.merchantDisplay}\n${formatCents(tx.amount, tx.currency)}\n\nClassify:`,
        { reply_markup: kb },
      );
    }
    await ctx.answerCallbackQuery({ text: 'Undone' });
  } catch (err) {
    const rid = crypto.randomUUID();
    log.error(rid, 'telegram_undo_confirm_failed', { txId, err: String(err) });
    await ctx.answerCallbackQuery({ text: `Error (${rid.slice(0, 8)})` }).catch(() => {});
  }
});

handlers.callbackQuery(/^pf_dismiss:(\d+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return;
  const pfId = Number(match[1]);
  try {
    const [pf] = await db.select().from(parseFailures).where(eq(parseFailures.id, pfId)).limit(1);
    if (!pf) {
      await ctx.answerCallbackQuery({ text: 'Not found' });
      return;
    }
    const now = new Date().toISOString();
    await db.update(parseFailures).set({ resolvedAt: now }).where(eq(parseFailures.id, pfId));
    const snippet = pf.rawText
      .slice(0, 500)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    await ctx.editMessageText(`🗑 Dismissed:\n${snippet}`);
    await ctx.answerCallbackQuery({ text: 'Dismissed' });
  } catch (err) {
    log.error('bot', 'pf_dismiss_failed', { pfId, err: String(err) });
    await ctx.answerCallbackQuery({ text: 'Error' }).catch(() => {});
  }
});

telegram?.bot.catch((err) => {
  log.error('bot', 'bot_error', {
    message: err.error instanceof Error ? err.error.message : 'unknown',
  });
});
