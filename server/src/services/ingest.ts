import { eq } from 'drizzle-orm';
import type { IngestStatus } from 'shared';
import { config } from '../config';
import { db } from '../db';
import { parseFailures, transactions } from '../db/schema';
import { log } from '../lib/log';
import { classifyMerchant } from './classifier';
import { assertDemoRoom } from './demo';
import { parseNotification } from './notification-parser';
import { normalizeWithOllama } from './ollama-normalizer';
import {
  sendClassifyPrompt,
  sendConfirmRulePrompt,
  sendConfirmation,
  sendParseFailedPrompt,
} from './telegram';

export type IngestResult = { status: IngestStatus; transactionId: number | null };

// One notification's path from raw text to a stored row (and a Telegram prompt
// when the bot is configured). Behind the Revolut webhook and the demo's
// simulated notifications. A parse failure has no transaction id.
export async function ingestNotification(
  text: string,
  receivedAt: Date,
  rid: string,
): Promise<IngestResult> {
  let parsed = parseNotification(text, receivedAt);
  // LLM output is untrusted: a rescued transaction always waits for a human,
  // even when a learned rule would otherwise auto-classify its merchant.
  let rescued = false;

  if (!parsed.ok && config.OLLAMA_ENABLED) {
    const rescue = await normalizeWithOllama(text, rid, receivedAt);
    if (rescue) {
      log.info(rid, 'webhook_ollama_rescued');
      parsed = { ok: true, value: rescue.parsed };
      rescued = true;
    }
  }

  // A full demo takes no more rows (403 demo_full); a no-op outside demo mode.
  if (!parsed.ok) {
    assertDemoRoom('parseFailures');
    const [inserted] = await db
      .insert(parseFailures)
      .values({
        rawText: text,
        errorCode: parsed.error.code,
        receivedAt: receivedAt.toISOString(),
      })
      .returning();
    if (inserted) {
      const msgId = await sendParseFailedPrompt({
        id: inserted.id,
        rawText: text,
      }).catch((err: unknown) => {
        log.error(rid, 'webhook_parse_failed_prompt_failed', {
          parseFailureId: inserted.id,
          err: String(err),
        });
        return null;
      });
      if (msgId !== null) {
        try {
          await db
            .update(parseFailures)
            .set({ telegramMessageId: msgId })
            .where(eq(parseFailures.id, inserted.id));
        } catch (err) {
          log.error(rid, 'webhook_msgid_update_failed', {
            parseFailureId: inserted.id,
            err: String(err),
          });
        }
      }
    }
    return { status: 'parse_failed', transactionId: null };
  }
  assertDemoRoom('transactions');

  const match = await classifyMerchant(parsed.value.merchant);
  const now = new Date().toISOString();

  if (match.walletId !== null && match.wallet !== null) {
    const wallet = match.wallet;
    if (match.requireConfirmation || rescued) {
      const [inserted] = await db
        .insert(transactions)
        .values({
          walletId: match.walletId,
          amount: parsed.value.amount,
          currency: parsed.value.currency,
          merchant: parsed.value.merchant,
          merchantDisplay: parsed.value.merchantDisplay,
          rawText: text,
          status: 'pending_confirmation',
          type: parsed.value.type,
          transactionDate: parsed.value.transactionDate,
        })
        .returning();
      if (inserted) {
        const msgId = await sendConfirmRulePrompt({
          id: inserted.id,
          merchantDisplay: parsed.value.merchantDisplay,
          amount: parsed.value.amount,
          currency: parsed.value.currency,
          walletName: wallet.name,
          walletIcon: wallet.icon,
        }).catch((err: unknown) => {
          log.error(rid, 'webhook_confirm_rule_prompt_failed', {
            transactionId: inserted.id,
            walletId: match.walletId,
            err: String(err),
          });
          return null;
        });
        if (msgId !== null) {
          await db
            .update(transactions)
            .set({ telegramMessageId: msgId })
            .where(eq(transactions.id, inserted.id))
            .catch((err: unknown) => {
              log.error(rid, 'webhook_msgid_update_failed', {
                transactionId: inserted.id,
                err: String(err),
              });
            });
        }
      }
      return { status: 'pending_confirmation', transactionId: inserted?.id ?? null };
    }
    const [inserted] = await db
      .insert(transactions)
      .values({
        walletId: match.walletId,
        amount: parsed.value.amount,
        currency: parsed.value.currency,
        merchant: parsed.value.merchant,
        merchantDisplay: parsed.value.merchantDisplay,
        rawText: text,
        status: 'classified',
        type: parsed.value.type,
        classifiedAt: now,
        transactionDate: parsed.value.transactionDate,
      })
      .returning();
    if (inserted) {
      await sendConfirmation({
        merchantDisplay: parsed.value.merchantDisplay,
        amount: parsed.value.amount,
        currency: parsed.value.currency,
        walletName: wallet.name,
        walletIcon: wallet.icon,
      }).catch((err: unknown) => {
        log.error(rid, 'webhook_classified_confirmation_failed', {
          transactionId: inserted.id,
          walletId: match.walletId,
          err: String(err),
        });
      });
    }
    return { status: 'classified', transactionId: inserted?.id ?? null };
  }

  const [inserted] = await db
    .insert(transactions)
    .values({
      walletId: null,
      amount: parsed.value.amount,
      currency: parsed.value.currency,
      merchant: parsed.value.merchant,
      merchantDisplay: parsed.value.merchantDisplay,
      rawText: text,
      status: 'pending',
      type: parsed.value.type,
      transactionDate: parsed.value.transactionDate,
    })
    .returning();
  if (inserted) {
    const msgId = await sendClassifyPrompt({
      id: inserted.id,
      merchantDisplay: parsed.value.merchantDisplay,
      amount: parsed.value.amount,
      currency: parsed.value.currency,
    }).catch((err: unknown) => {
      log.error(rid, 'webhook_classify_prompt_failed', {
        transactionId: inserted.id,
        err: String(err),
      });
      return null;
    });
    if (msgId !== null) {
      await db
        .update(transactions)
        .set({ telegramMessageId: msgId })
        .where(eq(transactions.id, inserted.id))
        .catch((err: unknown) => {
          log.error(rid, 'webhook_msgid_update_failed', {
            transactionId: inserted.id,
            err: String(err),
          });
        });
    }
  }
  return { status: 'pending', transactionId: inserted?.id ?? null };
}
