import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  IdParamSchema,
  TransactionCreateSchema,
  TransactionQuerySchema,
  TransactionUpdateSchema,
  monthBounds,
  normalizePattern,
} from 'shared';
import { config } from '../config';
import { db } from '../db';
import { transactions } from '../db/schema';
import { upsertExactRule } from '../services/classifier';

async function assertRelatedTxExists(relatedTxId: number): Promise<void> {
  const [row] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.id, relatedTxId))
    .limit(1);
  if (!row) throw new HTTPException(400, { message: 'related_tx_not_found' });
}

export const transactionsRoute = new Hono()
  .get('/', zValidator('query', TransactionQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const conditions = [];
    if (q.month) {
      const bounds = monthBounds(q.month, config.APP_TIMEZONE);
      if (bounds) {
        conditions.push(gte(transactions.transactionDate, bounds.startISO));
        conditions.push(lt(transactions.transactionDate, bounds.endISO));
      }
    }
    if (q.walletId !== undefined) conditions.push(eq(transactions.walletId, q.walletId));
    if (q.status) conditions.push(eq(transactions.status, q.status));
    if (q.type) conditions.push(eq(transactions.type, q.type));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db
      .select()
      .from(transactions)
      .where(where)
      .orderBy(desc(transactions.transactionDate))
      .limit(q.limit ?? 100)
      .offset(q.offset ?? 0);
    return c.json(rows);
  })
  .get('/:id', zValidator('param', IdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const [row] = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    if (!row) throw new HTTPException(404, { message: 'transaction_not_found' });
    return c.json(row);
  })
  .put(
    '/:id',
    zValidator('param', IdParamSchema),
    zValidator('json', TransactionUpdateSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const now = new Date().toISOString();
      const [existing] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, id))
        .limit(1);
      if (!existing) throw new HTTPException(404, { message: 'transaction_not_found' });

      const patch: Partial<typeof transactions.$inferInsert> = { updatedAt: now };
      if (body.walletId !== undefined) {
        patch.walletId = body.walletId;
        if (body.walletId !== null) {
          patch.status = body.status ?? 'classified';
          patch.classifiedAt = now;
        } else if (body.status === undefined) {
          // Unassigning the wallet (the edit modal always sends walletId, null for
          // "—") must not classify: a classified row with no wallet is invisible to
          // every stats aggregation. Send it back to the pending queue instead.
          patch.status = 'pending';
          patch.classifiedAt = null;
        }
      }
      if (body.amount !== undefined) patch.amount = body.amount;
      if (body.description !== undefined) patch.description = body.description;
      if (body.status !== undefined) patch.status = body.status;
      if (body.type !== undefined) patch.type = body.type;
      if (body.relatedTxId !== undefined) {
        if (body.relatedTxId === id) {
          throw new HTTPException(400, { message: 'related_tx_self_reference' });
        }
        if (body.relatedTxId !== null) await assertRelatedTxExists(body.relatedTxId);
        patch.relatedTxId = body.relatedTxId;
      }

      const effectiveRelatedTxId =
        body.relatedTxId !== undefined ? body.relatedTxId : existing.relatedTxId;
      if ((body.type ?? existing.type) === 'adjustment' && effectiveRelatedTxId == null) {
        throw new HTTPException(400, { message: 'adjustment_requires_related_tx' });
      }

      const [row] = await db
        .update(transactions)
        .set(patch)
        .where(eq(transactions.id, id))
        .returning();

      const effectiveType = body.type ?? existing.type;
      if (
        body.walletId !== undefined &&
        body.walletId !== null &&
        existing.merchant &&
        effectiveType === 'expense'
      ) {
        await upsertExactRule(existing.merchant, body.walletId);
      }
      return c.json(row);
    },
  )
  .post('/', zValidator('json', TransactionCreateSchema), async (c) => {
    const body = c.req.valid('json');
    if (body.relatedTxId != null) await assertRelatedTxExists(body.relatedTxId);
    const now = new Date().toISOString();
    const merchant = normalizePattern(body.merchantDisplay);
    const [row] = await db
      .insert(transactions)
      .values({
        walletId: body.walletId,
        amount: body.amount,
        currency: body.currency ?? 'EUR',
        merchant: merchant || body.merchantDisplay.toLowerCase(),
        merchantDisplay: body.merchantDisplay,
        description: body.description ?? null,
        rawText: `manual:${body.type}`,
        status: 'classified',
        type: body.type,
        relatedTxId: body.relatedTxId ?? null,
        classifiedAt: now,
        transactionDate: body.transactionDate,
      })
      .returning();
    return c.json(row, 201);
  })
  .delete('/:id', zValidator('param', IdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const [row] = await db.delete(transactions).where(eq(transactions.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'transaction_not_found' });
    return c.json({ ok: true });
  });
