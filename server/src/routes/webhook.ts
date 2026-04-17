import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { WebhookBodySchema } from 'shared';
import { db } from '../db';
import { parseFailures, transactions } from '../db/schema';
import { getClientIp } from '../lib/client-ip';
import { log } from '../lib/log';
import { rateLimit } from '../middleware/rate-limit';
import { webhookSecret } from '../middleware/webhook-secret';
import { classifyMerchant } from '../services/classifier';
import { parseNotification } from '../services/notification-parser';
import { sendClassifyPrompt, sendConfirmation, sendParseFailedPrompt } from '../services/telegram';

type Variables = { requestId: string };

export const webhookRoute = new Hono<{ Variables: Variables }>()
  .use('*', webhookSecret)
  .use(
    '*',
    rateLimit({
      capacity: 60,
      refillPerSecond: 1,
      keyFn: getClientIp,
    }),
  )
  .post('/revolut', zValidator('json', WebhookBodySchema), async (c) => {
    const rid = c.get('requestId') ?? 'unknown';
    const body = c.req.valid('json');
    const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
    const parsed = parseNotification(body.text, receivedAt);

    if (!parsed.ok) {
      const [inserted] = await db
        .insert(parseFailures)
        .values({
          rawText: body.text,
          errorCode: parsed.error.code,
          receivedAt: receivedAt.toISOString(),
        })
        .returning();
      if (inserted) {
        const msgId = await sendParseFailedPrompt({
          id: inserted.id,
          rawText: body.text,
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
      return c.json({ ok: true, status: 'parse_failed' });
    }

    const match = await classifyMerchant(parsed.value.merchant);
    const now = new Date().toISOString();

    if (match.walletId !== null && match.wallet !== null) {
      const wallet = match.wallet;
      const [inserted] = await db
        .insert(transactions)
        .values({
          walletId: match.walletId,
          amount: parsed.value.amount,
          currency: parsed.value.currency,
          merchant: parsed.value.merchant,
          merchantDisplay: parsed.value.merchantDisplay,
          rawText: body.text,
          status: 'classified',
          type: 'expense',
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
      return c.json({ ok: true, status: 'classified' });
    }

    const [inserted] = await db
      .insert(transactions)
      .values({
        walletId: null,
        amount: parsed.value.amount,
        currency: parsed.value.currency,
        merchant: parsed.value.merchant,
        merchantDisplay: parsed.value.merchantDisplay,
        rawText: body.text,
        status: 'pending',
        type: 'expense',
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
    return c.json({ ok: true, status: 'pending' });
  });
