import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  IdParamSchema,
  TransactionQuerySchema,
  TransactionUpdateSchema,
  monthBounds,
} from 'shared';
import { config } from '../config';
import { db } from '../db';
import { transactions } from '../db/schema';
import { upsertExactRule } from '../services/classifier';

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
        patch.status = body.status ?? 'classified';
        patch.classifiedAt = now;
      }
      if (body.amount !== undefined) patch.amount = body.amount;
      if (body.description !== undefined) patch.description = body.description;
      if (body.status !== undefined) patch.status = body.status;

      const [row] = await db
        .update(transactions)
        .set(patch)
        .where(eq(transactions.id, id))
        .returning();

      if (body.walletId !== undefined && body.walletId !== null && existing.merchant) {
        await upsertExactRule(existing.merchant, body.walletId);
      }
      return c.json(row);
    },
  )
  .delete('/:id', zValidator('param', IdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const [row] = await db.delete(transactions).where(eq(transactions.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'transaction_not_found' });
    return c.json({ ok: true });
  });
