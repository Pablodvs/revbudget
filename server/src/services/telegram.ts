import { and, eq, gte, lt, ne, sum } from 'drizzle-orm';
import { Bot, InlineKeyboard } from 'grammy';
import { currentMonth, formatCents, monthBounds } from 'shared';
import { config } from '../config';
import { db } from '../db';
import { parseFailures, transactions, wallets } from '../db/schema';
import { log } from '../lib/log';
import { classifyMerchant, deleteRuleByPattern, upsertExactRule } from './classifier';

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (chatId === undefined || chatId !== config.TELEGRAM_CHAT_ID) {
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
  const kb = await buildClassifyKeyboard(tx.id);
  const msg = await bot.api.sendMessage(
    config.TELEGRAM_CHAT_ID,
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
  await bot.api.sendMessage(
    config.TELEGRAM_CHAT_ID,
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
  const msg = await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, confirmRulePromptText(tx), {
    reply_markup: buildConfirmRuleKeyboard(tx.id),
  });
  return msg.message_id ?? null;
}

export async function sendParseFailedPrompt(pf: {
  id: number;
  rawText: string;
}): Promise<number | null> {
  const snippet = pf.rawText
    .slice(0, 500)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  const kb = new InlineKeyboard().text('🗑 Dismiss', `pf_dismiss:${pf.id}`);
  const msg = await bot.api.sendMessage(
    config.TELEGRAM_CHAT_ID,
    `⚠️ Could not parse notification:\n${snippet}`,
    { reply_markup: kb },
  );
  return msg.message_id ?? null;
}

bot.command('start', async (ctx) => {
  await ctx.reply('👋 RevBudget bot ready. Use /status or /wallets.');
});

bot.command('status', async (ctx) => {
  const month = currentMonth(new Date(), config.APP_TIMEZONE);
  const bounds = monthBounds(month, config.APP_TIMEZONE);
  if (!bounds) return;
  const walletRows = await db.select().from(wallets).where(eq(wallets.isActive, true));
  const rows = await db
    .select({
      walletId: transactions.walletId,
      total: sum(transactions.amount).mapWith(Number),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, 'classified'),
        gte(transactions.transactionDate, bounds.startISO),
        lt(transactions.transactionDate, bounds.endISO),
      ),
    )
    .groupBy(transactions.walletId);
  const byWallet = new Map(rows.map((r) => [r.walletId, r.total ?? 0]));
  let total = 0;
  const lines = walletRows.map((w) => {
    const spent = byWallet.get(w.id) ?? 0;
    total += spent;
    const pct = w.budget > 0 ? Math.round((spent / w.budget) * 100) : 0;
    return `${w.icon ?? ''} ${w.name}: ${formatCents(spent, w.currency)} / ${formatCents(w.budget, w.currency)} (${pct}%)`;
  });
  await ctx.reply(`📊 *${month}*\nTotal: ${formatCents(total, 'EUR')}\n\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
  });
});

bot.command('wallets', async (ctx) => {
  const walletRows = await db.select().from(wallets).where(eq(wallets.isActive, true));
  const lines = walletRows.map(
    (w) => `${w.icon ?? ''} ${w.name} — budget ${formatCents(w.budget, w.currency)}`,
  );
  await ctx.reply(lines.join('\n') || 'No active wallets');
});

bot.callbackQuery(/^classify:(\d+):(\d+)$/, async (ctx) => {
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
    const now = new Date().toISOString();
    await db
      .update(transactions)
      .set({ walletId, status: 'classified', classifiedAt: now, updatedAt: now })
      .where(eq(transactions.id, txId));
    if (tx.merchant) {
      await upsertExactRule(tx.merchant, walletId);
    }
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

bot.callbackQuery(/^ignore:(\d+)$/, async (ctx) => {
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

bot.callbackQuery(/^undo:(\d+)$/, async (ctx) => {
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
    if (tx.merchant) {
      await deleteRuleByPattern(tx.merchant);
    }
    const now = new Date().toISOString();
    await db
      .update(transactions)
      .set({ walletId: null, status: 'pending', classifiedAt: null, updatedAt: now })
      .where(eq(transactions.id, txId));
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

bot.callbackQuery(/^confirm_rule:(\d+)$/, async (ctx) => {
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

bot.callbackQuery(/^choose_other:(\d+)$/, async (ctx) => {
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

bot.callbackQuery(/^confirm_back:(\d+)$/, async (ctx) => {
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

bot.callbackQuery(/^reassign:(\d+):(\d+)$/, async (ctx) => {
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

bot.callbackQuery(/^undo_confirm:(\d+)$/, async (ctx) => {
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
    if (result.walletId !== null && result.wallet !== null) {
      if (result.requireConfirmation) {
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
          .set({
            walletId: result.walletId,
            status: 'classified',
            classifiedAt: now,
            updatedAt: now,
          })
          .where(eq(transactions.id, txId));
        const text =
          `✅ ${tx.merchantDisplay} ${formatCents(tx.amount, tx.currency)} → ${result.wallet.name} ${result.wallet.icon ?? ''}`.trim();
        await ctx.editMessageText(text);
      }
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

bot.callbackQuery(/^pf_dismiss:(\d+)$/, async (ctx) => {
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

bot.catch((err) => {
  log.error('bot', 'bot_error', {
    message: err.error instanceof Error ? err.error.message : 'unknown',
  });
});
